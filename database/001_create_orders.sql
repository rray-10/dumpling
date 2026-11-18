-- =====================================================================
-- 金邊鍋貼｜訂單資料表（Supabase PostgreSQL）
-- 001_create_orders.sql
--
-- 架構：網站 → Supabase Edge Function（以 service_role 呼叫）→ 本檔的資料表/函式
-- 訪客（anon / authenticated）不能直接讀寫任何訂單資料。
--
-- 可重複執行：只使用 IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING，
-- 不含 DROP TABLE、TRUNCATE、DELETE。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. 商品價格表（原 Sheet: Products）— 後端計價的唯一來源
-- ---------------------------------------------------------------------
create table if not exists public.products (
  id          text primary key,                                  -- 原「商品ID」，例 p1
  category    text not null
              check (category in ('signature','dumpling','soup','side','gift')), -- 原「分類」
  name        text not null check (char_length(name) between 1 and 100),       -- 原「品名」
  price       integer not null check (price >= 0),               -- 原「價格」（新台幣整數）
  is_active   boolean not null default true,                     -- 原「上架」
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 種子資料：取自 gas/Code.gs 的 PRODUCTS_SEED。已存在的商品不覆寫（保留你之後改的價格）。
insert into public.products (id, category, name, price) values
  ('p1',  'signature', '招牌豬肉鍋貼（12 入）',     150),
  ('p2',  'signature', '爆汁起司鍋貼（10 入）',     180),
  ('p3',  'signature', '韭香辣味鍋貼（12 入）',     160),
  ('p4',  'signature', '素食高麗菜鍋貼（12 入）',   140),
  ('p5',  'dumpling',  '手工高麗菜水餃（20 入）',   170),
  ('p6',  'dumpling',  '薑絲蛤蜊水餃（16 入）',     210),
  ('p7',  'dumpling',  '紅油抄手（14 入）',         190),
  ('p8',  'soup',      '酸辣湯',                     80),
  ('p9',  'soup',      '老母雞湯',                  120),
  ('p10', 'soup',      '冬瓜薏仁飲',                 45),
  ('p11', 'side',      '涼拌小黃瓜',                 60),
  ('p12', 'side',      '椒麻雞絲',                  130),
  ('g1',  'gift',      '招牌招財鍋貼禮盒（50 入）', 1280),
  ('g2',  'gift',      '家庭分享禮盒（30 入）',     780)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. 訂單主檔（原 Sheet: Orders，一張訂單一列）
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id            bigint generated always as identity primary key,  -- 新增：內部主鍵
  order_no      text not null unique
                check (order_no ~ '^JB[0-9]{9}$'),                -- 原「訂單編號」JB+yyMMdd+3 碼
  request_id    text not null unique
                check (request_id ~ '^[A-Za-z0-9-]{8,64}$'),      -- 原「RequestId」，改為永久防重複
  status        text not null default 'received'
                check (status in ('received','preparing','ready','completed','cancelled')),
                -- 原「狀態」：已收到/製作中/可取餐/已完成；cancelled（已取消）為新增
  order_type    text not null
                check (order_type in ('dine','takeout','delivery')), -- 原「取餐方式」，改存代碼
  customer_name text not null check (char_length(customer_name) between 1 and 50), -- 原「姓名」
  phone         text not null check (phone ~ '^[0-9+() -]{8,15}$'),               -- 原「電話」（原字串）
  phone_digits  text generated always as (regexp_replace(phone, '[^0-9]', '', 'g')) stored,
                -- 新增：純數字電話，供「訂單編號＋電話」查詢比對
  address       text check (address is null or char_length(address) <= 120),     -- 原「配送地址」
  pickup_time   time,                                              -- 原「希望時間」HH:mm（台北時間、當日）
  note          text check (note is null or char_length(note) <= 200),            -- 原「備註」
  subtotal      integer not null check (subtotal >= 0),            -- 原「小計」
  shipping_fee  integer not null default 0 check (shipping_fee >= 0), -- 原「運費」
  total         integer not null check (total >= 0),               -- 原「應付總額」
  created_at    timestamptz not null default now(),                -- 原「建立時間」（含時區）
  updated_at    timestamptz not null default now(),                -- 原「更新時間」
  constraint orders_total_matches check (total = subtotal + shipping_fee),
  constraint orders_delivery_needs_address
    check (order_type <> 'delivery' or (address is not null and char_length(address) >= 1))
);
-- 原「品項摘要」不建欄位：需要時由 order_items 組出。

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx     on public.orders (status);

-- ---------------------------------------------------------------------
-- 3. 訂單明細（原 Sheet: OrderItems，每品項一列）
-- ---------------------------------------------------------------------
create table if not exists public.order_items (
  id            bigint generated always as identity primary key,   -- 新增
  order_id      bigint not null references public.orders (id) on delete restrict, -- 原「訂單編號」對應
  product_id    text not null references public.products (id) on delete restrict, -- 原「商品ID」
  product_name  text not null,                                      -- 原「品名」（下單當下快照）
  unit_price    integer not null check (unit_price >= 0),           -- 原「單價」（下單當下快照）
  qty           integer not null check (qty between 1 and 99),      -- 原「數量」
  line_total    integer not null check (line_total >= 0),           -- 原「小計」
  constraint order_items_line_total_matches check (line_total = unit_price * qty),
  constraint order_items_unique_product unique (order_id, product_id) -- 同商品已合併成一列
);

create index if not exists order_items_order_id_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------
-- 4. 每日流水號（取代 Apps Script 的 ScriptProperties seq_yyMMdd）
-- ---------------------------------------------------------------------
create table if not exists public.order_daily_seq (
  day       date primary key,             -- 台北日期
  last_seq  integer not null check (last_seq between 0 and 999)
);

-- ---------------------------------------------------------------------
-- 5. updated_at 自動更新（取代 Apps Script 的 onEdit）
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create or replace trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 6. 產生訂單編號：JB + 台北日期 yyMMdd + 當日 3 碼流水號
--    以 upsert 取號，交易中原子遞增；超過 999 直接報錯（原程式會重號）。
-- ---------------------------------------------------------------------
create or replace function public.next_order_no()
returns text
language plpgsql
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'Asia/Taipei')::date;
  v_seq integer;
begin
  insert into public.order_daily_seq as s (day, last_seq)
  values (v_day, 1)
  on conflict (day) do update set last_seq = s.last_seq + 1
  returning s.last_seq into v_seq;   -- 超過 999 會被 check 擋下

  return 'JB' || to_char(v_day, 'YYMMDD') || lpad(v_seq::text, 3, '0');
end;
$$;

-- ---------------------------------------------------------------------
-- 7. 建立訂單（Edge Function 呼叫）：驗證 → 防重複 → 計價 → 寫入，全在同一交易
--    規則對應 gas/Code.gs 的 parse_() 與 price_()。
--    使用者可見錯誤以 SQLSTATE P0001 + 中文訊息拋出，Edge Function 可直接轉給前端。
-- ---------------------------------------------------------------------
create or replace function public.create_order(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  c_shipping_fee constant integer := 60;    -- 原 CONFIG.SHIPPING_FEE
  c_free_from    constant integer := 500;   -- 原 CONFIG.FREE_SHIPPING_FROM
  c_max_items    constant integer := 50;    -- 原 CONFIG.MAX_ITEMS
  c_max_qty      constant integer := 99;    -- 原 CONFIG.MAX_QTY

  v_request_id text := left(coalesce(p->>'requestId', ''), 64);
  v_type       text := coalesce(p->>'type', '');
  v_name       text := btrim(coalesce(p->>'name', ''));
  v_phone      text := btrim(coalesce(p->>'phone', ''));
  v_address    text := nullif(btrim(coalesce(p->>'address', '')), '');
  v_time_raw   text := left(btrim(coalesce(p->>'time', '')), 10);
  v_note       text := nullif(left(btrim(coalesce(p->>'note', '')), 200), '');
  v_items      jsonb := p->'items';

  v_existing   text;
  v_pickup     time;
  v_bad        integer;
  v_merged     jsonb;
  v_subtotal   integer;
  v_shipping   integer;
  v_order_id   bigint;
  v_order_no   text;
begin
  -- 基本驗證（同 parse_）
  if v_request_id !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception '缺少有效的訂單識別碼' using errcode = 'P0001';
  end if;
  if v_type not in ('dine','takeout','delivery') then
    raise exception '取餐方式不正確' using errcode = 'P0001';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 50 then
    raise exception '請輸入姓名' using errcode = 'P0001';
  end if;
  if v_phone !~ '^[0-9+() -]{8,15}$' then
    raise exception '請輸入有效的聯絡電話' using errcode = 'P0001';
  end if;
  if v_type = 'delivery' and (v_address is null or char_length(v_address) > 120) then
    raise exception '宅配請填寫配送地址' using errcode = 'P0001';
  end if;
  if v_type <> 'delivery' then
    v_address := null;   -- 同前端：非宅配不存地址
  end if;
  if v_time_raw <> '' then
    if v_time_raw !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception '希望時間格式不正確' using errcode = 'P0001';
    end if;
    v_pickup := v_time_raw::time;
  end if;
  if v_items is null or jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) < 1 or jsonb_array_length(v_items) > c_max_items then
    raise exception '購物車是空的' using errcode = 'P0001';
  end if;

  -- 防重複送出：同 request_id 的並行請求互相等待，已存在就回傳原編號
  perform pg_advisory_xact_lock(hashtext('create_order:' || v_request_id));
  select order_no into v_existing from public.orders where request_id = v_request_id;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'orderNo', v_existing, 'duplicate', true,
      'total', (select total from public.orders where order_no = v_existing));
  end if;

  -- 逐筆檢查數量（同 price_：每筆 1–99 的整數）
  select count(*) into v_bad
  from jsonb_array_elements(v_items) e
  where case
          when jsonb_typeof(e) <> 'object' then true
          when coalesce(jsonb_typeof(e->'qty'), '') <> 'number' then true
          else (e->>'qty')::numeric <> floor((e->>'qty')::numeric)
               or (e->>'qty')::numeric < 1 or (e->>'qty')::numeric > c_max_qty
        end;
  if v_bad > 0 then
    raise exception '商品數量不正確' using errcode = 'P0001';
  end if;

  -- 合併相同商品、對照上架中的價格表
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', m.id, 'product_name', pr.name, 'unit_price', pr.price, 'qty', m.qty)), '[]')
  into v_merged
  from (
    select coalesce(e->>'id', '') as id, sum((e->>'qty')::integer)::integer as qty
    from jsonb_array_elements(v_items) e
    group by 1
  ) m
  left join public.products pr on pr.id = m.id and pr.is_active;

  if exists (select 1 from jsonb_array_elements(v_merged) x where x->>'product_name' is null) then
    raise exception '有商品已下架或不存在，請重新整理頁面後再試' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_merged) x where (x->>'qty')::int > c_max_qty) then
    raise exception '商品數量不正確' using errcode = 'P0001';
  end if;

  select sum((x->>'unit_price')::int * (x->>'qty')::int)::integer into v_subtotal
  from jsonb_array_elements(v_merged) x;
  v_shipping := case when v_type = 'delivery' and v_subtotal < c_free_from
                     then c_shipping_fee else 0 end;

  v_order_no := public.next_order_no();

  insert into public.orders (order_no, request_id, order_type, customer_name, phone,
                             address, pickup_time, note, subtotal, shipping_fee, total)
  values (v_order_no, v_request_id, v_type, v_name, v_phone,
          v_address, v_pickup, v_note, v_subtotal, v_shipping, v_subtotal + v_shipping)
  returning id into v_order_id;

  insert into public.order_items (order_id, product_id, product_name, unit_price, qty, line_total)
  select v_order_id, x->>'product_id', x->>'product_name',
         (x->>'unit_price')::int, (x->>'qty')::int, (x->>'unit_price')::int * (x->>'qty')::int
  from jsonb_array_elements(v_merged) x;

  return jsonb_build_object('ok', true, 'orderNo', v_order_no,
                            'total', v_subtotal + v_shipping, 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------
-- 8. 訂單查詢（取代 lookup_）：訂單編號＋電話相符才回傳；不含姓名、地址、電話
-- ---------------------------------------------------------------------
create or replace function public.lookup_order(p_order_no text, p_phone text)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_no    text := upper(btrim(coalesce(p_order_no, '')));
  v_ph    text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  o       public.orders%rowtype;
begin
  if v_no !~ '^[A-Z]{1,4}[0-9]{9}$' then
    raise exception '請輸入正確的訂單編號' using errcode = 'P0001';
  end if;
  if char_length(v_ph) < 8 then
    raise exception '請輸入下單時的電話' using errcode = 'P0001';
  end if;

  select * into o from public.orders where order_no = v_no and phone_digits = v_ph;
  if not found then
    raise exception '查無此訂單，請確認訂單編號與電話' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'orderNo', o.order_no,
    'status', o.status,               -- 代碼；中文標籤由 Edge Function / 前端轉換
    'type', o.order_type,
    'createdAt', o.created_at,        -- ISO 8601 含時區
    'updatedAt', o.updated_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', i.product_name, 'price', i.unit_price, 'qty', i.qty)
                       order by i.id)
      from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'subtotal', o.subtotal,
    'shipping', o.shipping_fee,
    'total', o.total
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 9. RLS 與權限
--    - 四張表都啟用 RLS，且「不建立任何 policy」→ anon/authenticated 一律被拒。
--    - 撤銷 anon/authenticated 的表格與函式權限（Supabase 預設會給 public schema 新物件權限）。
--    - 只授權 service_role（Edge Function 使用；service_role 會略過 RLS）。
-- ---------------------------------------------------------------------
alter table public.products        enable row level security;
alter table public.orders          enable row level security;
alter table public.order_items     enable row level security;
alter table public.order_daily_seq enable row level security;

revoke all on table public.products, public.orders, public.order_items, public.order_daily_seq
  from public, anon, authenticated;

grant select, insert, update          on table public.products        to service_role;
grant select, insert, update          on table public.orders          to service_role;
grant select, insert                  on table public.order_items     to service_role;
grant select, insert, update          on table public.order_daily_seq to service_role;
grant usage, select on sequence public.orders_id_seq, public.order_items_id_seq to service_role;
revoke all on sequence public.orders_id_seq, public.order_items_id_seq from public, anon, authenticated;

revoke all on function public.set_updated_at()              from public, anon, authenticated;
revoke all on function public.next_order_no()               from public, anon, authenticated;
revoke all on function public.create_order(jsonb)           from public, anon, authenticated;
revoke all on function public.lookup_order(text, text)      from public, anon, authenticated;
grant execute on function public.next_order_no()            to service_role;
grant execute on function public.create_order(jsonb)        to service_role;
grant execute on function public.lookup_order(text, text)   to service_role;

commit;
