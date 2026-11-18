-- =====================================================================
-- 金邊鍋貼｜建表查核與寫入測試
-- 002_verify_orders.sql（請在 001 執行成功後執行）
--
-- 第 1 部分：唯讀查核（結構、RLS、權限）
-- 第 2 部分：在 BEGIN … ROLLBACK 中以虛構訂單測試寫入/查詢，最後全部回滾
-- 第 3 部分：確認沒有留下測試訂單
-- 不含 DELETE / TRUNCATE / DROP TABLE，不會動到既有資料。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 第 1 部分：唯讀查核（每列 ok 應為 true）
-- ---------------------------------------------------------------------
select check_name, ok from (
  select 1 as n, '四張表都存在' as check_name,
         (select count(*) from information_schema.tables
          where table_schema = 'public'
            and table_name in ('products','orders','order_items','order_daily_seq')) = 4 as ok
  union all
  select 2, '四張表都已啟用 RLS',
         (select bool_and(relrowsecurity) from pg_class
          where relnamespace = 'public'::regnamespace
            and relname in ('products','orders','order_items','order_daily_seq'))
  union all
  select 3, '四張表沒有任何 RLS policy（訪客一律拒絕）',
         not exists (select 1 from pg_policies where schemaname = 'public'
                     and tablename in ('products','orders','order_items','order_daily_seq'))
  union all
  select 4, 'anon 對訂單相關表沒有任何權限',
         not exists (select 1 from information_schema.role_table_grants
                     where table_schema = 'public' and grantee in ('anon','authenticated')
                       and table_name in ('products','orders','order_items','order_daily_seq'))
  union all
  select 5, 'service_role 可讀寫 orders',
         has_table_privilege('service_role', 'public.orders', 'select,insert,update')
  union all
  select 6, 'anon 不能執行 create_order / lookup_order',
         not has_function_privilege('anon', 'public.create_order(jsonb)', 'execute')
         and not has_function_privilege('anon', 'public.lookup_order(text,text)', 'execute')
  union all
  select 7, 'service_role 可執行 create_order / lookup_order',
         has_function_privilege('service_role', 'public.create_order(jsonb)', 'execute')
         and has_function_privilege('service_role', 'public.lookup_order(text,text)', 'execute')
  union all
  select 8, 'orders.created_at 為 timestamptz',
         (select data_type from information_schema.columns
          where table_schema='public' and table_name='orders' and column_name='created_at')
         = 'timestamp with time zone'
  union all
  select 9, 'products 已有種子商品（至少 14 筆）',
         (select count(*) from public.products) >= 14
) t order by n;

-- ---------------------------------------------------------------------
-- 第 2 部分：寫入／查詢測試（全部在交易內，最後 ROLLBACK）
-- 失敗時會出現 ERROR 並指出哪一項；成功則不會有錯誤。
-- ---------------------------------------------------------------------
begin;

do $$
declare
  r        jsonb;
  r2       jsonb;
  q        jsonb;
  v_no     text;
  v_p1     integer;
  v_p8     integer;
  v_err    text;
  v_today  text := to_char(now() at time zone 'Asia/Taipei', 'YYMMDD');
begin
  select price into v_p1 from public.products where id = 'p1';
  select price into v_p8 from public.products where id = 'p8';

  -- T1 外帶、多品項、同商品分兩筆送 → 應合併
  r := public.create_order(jsonb_build_object(
    'requestId', 'verify-test-0001',
    'type', 'takeout',
    'name', '測試顧客',
    'phone', '0900-000-000',
    'address', '這段地址應被忽略',
    'time', '18:30',
    'note', '虛構測試訂單',
    'items', jsonb_build_array(
      jsonb_build_object('id','p1','qty',1),
      jsonb_build_object('id','p1','qty',1),
      jsonb_build_object('id','p8','qty',1))));
  v_no := r->>'orderNo';
  assert (r->>'ok')::boolean, 'T1 建單失敗';
  assert v_no ~ ('^JB' || v_today || '[0-9]{3}$'), 'T1 訂單編號格式錯誤：' || v_no;
  assert (r->>'total')::int = v_p1 * 2 + v_p8, 'T1 總額錯誤';
  assert (select count(*) from public.order_items i join public.orders o on o.id = i.order_id
          where o.order_no = v_no) = 2, 'T1 明細應合併為 2 列';
  assert (select address is null and status = 'received' and shipping_fee = 0
                 and pickup_time = '18:30'::time and phone_digits = '0900000000'
          from public.orders where order_no = v_no), 'T1 欄位內容錯誤';

  -- T2 同 requestId 重送 → 回傳同一編號，不新增
  r2 := public.create_order(jsonb_build_object(
    'requestId', 'verify-test-0001', 'type', 'takeout', 'name', '測試顧客',
    'phone', '0900-000-000', 'items', jsonb_build_array(jsonb_build_object('id','p1','qty',1))));
  assert r2->>'orderNo' = v_no and (r2->>'duplicate')::boolean, 'T2 重複送出未被擋下';
  assert (select count(*) from public.orders where request_id = 'verify-test-0001') = 1, 'T2 產生了重複訂單';

  -- T3 宅配未滿 500 → 運費 60；流水號遞增
  r := public.create_order(jsonb_build_object(
    'requestId', 'verify-test-0002', 'type', 'delivery', 'name', '測試顧客二',
    'phone', '+886 900 000 001', 'address', '虛構市測試路 1 號',
    'items', jsonb_build_array(jsonb_build_object('id','p8','qty',1))));
  assert (r->>'total')::int = v_p8 + (case when v_p8 < 500 then 60 else 0 end), 'T3 運費計算錯誤';
  assert right(r->>'orderNo', 3)::int = right(v_no, 3)::int + 1, 'T3 流水號未遞增';

  -- T4 查詢：電話相符（格式不同也可）→ 回傳，且不含姓名/地址
  q := public.lookup_order(lower(v_no), '0900000000');
  assert q->>'orderNo' = v_no and jsonb_array_length(q->'items') = 2, 'T4 查詢結果錯誤';
  assert not (q ? 'name') and not (q ? 'address') and not (q ? 'phone'), 'T4 不應回傳個資';

  -- T5 查詢：電話不符 → 查無
  begin
    perform public.lookup_order(v_no, '0911111111');
    raise exception 'T5 應查無訂單';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_err = message_text;
    assert v_err = '查無此訂單，請確認訂單編號與電話', 'T5 錯誤訊息不符：' || v_err;
  end;

  -- T6 不存在的商品 → 拒絕
  begin
    perform public.create_order(jsonb_build_object(
      'requestId', 'verify-test-0003', 'type', 'dine', 'name', '測試',
      'phone', '0900000000', 'items', jsonb_build_array(jsonb_build_object('id','no-such','qty',1))));
    raise exception 'T6 應拒絕不存在的商品';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_err = message_text;
    assert v_err like '有商品已下架%', 'T6 錯誤訊息不符：' || v_err;
  end;

  -- T7 數量非整數 → 拒絕
  begin
    perform public.create_order(jsonb_build_object(
      'requestId', 'verify-test-0004', 'type', 'dine', 'name', '測試',
      'phone', '0900000000', 'items', jsonb_build_array(jsonb_build_object('id','p1','qty',1.5))));
    raise exception 'T7 應拒絕非整數數量';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_err = message_text;
    assert v_err = '商品數量不正確', 'T7 錯誤訊息不符：' || v_err;
  end;

  -- T8 宅配缺地址 → 拒絕
  begin
    perform public.create_order(jsonb_build_object(
      'requestId', 'verify-test-0005', 'type', 'delivery', 'name', '測試',
      'phone', '0900000000', 'items', jsonb_build_array(jsonb_build_object('id','p1','qty',1))));
    raise exception 'T8 應要求地址';
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_err = message_text;
    assert v_err = '宅配請填寫配送地址', 'T8 錯誤訊息不符：' || v_err;
  end;

  -- T9 改狀態 → updated_at 由 trigger 更新；不合法狀態被 check 擋下
  update public.orders set status = 'preparing', updated_at = '2000-01-01' where order_no = v_no;
  assert (select updated_at > '2000-01-02' from public.orders where order_no = v_no), 'T9 updated_at 未自動更新';
  begin
    update public.orders set status = 'unknown' where order_no = v_no;
    raise exception 'T9 應拒絕不合法狀態';
  exception when check_violation then null;
  end;

  raise notice '全部測試通過（T1–T9），即將 ROLLBACK';
end;
$$;

rollback;

-- ---------------------------------------------------------------------
-- 第 3 部分：確認測試資料已回滾（應為 0）
-- ---------------------------------------------------------------------
select count(*) as leftover_test_orders
from public.orders
where request_id like 'verify-test-%';
