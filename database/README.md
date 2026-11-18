# database／訂單資料庫（Supabase PostgreSQL）

這個資料夾放的是把訂單從「Google Apps Script＋Google Sheet」搬到 Supabase 用的 SQL。
目前**只有 SQL 檔**，網站（`index.html`、`order.html`）和 `gas/Code.gs` 都還沒改，網站仍然把訂單送到 Google Sheet。

預定架構：

```
網站（anon key，只呼叫 Edge Function）
  └─▶ Supabase Edge Function（伺服器端，使用 service_role）
        └─▶ create_order() / lookup_order() ─▶ orders / order_items / products
```

訪客**不能**直接讀寫任何資料表，只能透過 Edge Function 存取。

## 檔案與執行順序

| 順序 | 檔案 | 用途 |
|---|---|---|
| 1 | `001_create_orders.sql` | 建立資料表、限制、預設值、函式、RLS 和權限，並寫入 14 筆商品種子資料 |
| 2 | `002_verify_orders.sql` | 檢查建表結果，用虛構訂單測試寫入和查詢，測試資料最後全部回滾 |

執行方式：打開 Supabase Dashboard → **SQL Editor**，把整份檔案內容貼上並按 Run，001 跑完再跑 002。
（也可以用 `psql -f`。這次 SQL 是由你自己執行，Claude 沒有連線到任何雲端資料庫。）

## 每一步預期看到的結果

**執行 001**
- 顯示 `Success. No rows returned`。
- Table Editor 會出現 `products`、`orders`、`order_items`、`order_daily_seq` 四張表，每張都標示 RLS enabled。
- `products` 有 14 筆商品。
- 001 可以重複執行。已存在的表不會重建，已存在的商品不會被覆寫（你之後改的價格會保留）。

**執行 002**
- 第 1 部分會回傳 9 列檢查結果，`ok` 欄應該**全部是 `true`**。
- 第 2 部分若全部通過，不會出現錯誤，用 psql 執行時會看到 `NOTICE: 全部測試通過（T1–T9）`。
  如果有測試失敗，會出現 `ERROR`，訊息會寫出是哪一項（例如 `T3 運費計算錯誤`），整段也會自動回滾。
- 第 3 部分回傳 `leftover_test_orders = 0`，表示假訂單沒有留下。
- SQL Editor 通常只顯示**最後一個**查詢結果，也就是第 3 部分。想看第 1 部分的結果，可以只選取那一段單獨執行。
- 小提醒：回滾後 `orders.id` 的自動編號會跳號，這是 PostgreSQL 序列的正常行為。訂單編號 `JB…` **不會**跳號，因為每日流水號存在一般資料表裡，會跟著一起回滾。

## 設計來源對照

### 沿用原專案（`gas/Code.gs`）的設計

| 項目 | 原本 | 現在 |
|---|---|---|
| 訂單主檔／明細分開 | Sheet 的 `Orders`／`OrderItems` | `orders`／`order_items`，明細用外鍵對應 |
| 價格表 | `Products` 分頁 | `products` 表，種子資料取自 `PRODUCTS_SEED` |
| 金額由後端重算 | `price_()` | `create_order()`：前端只送商品 ID 和數量 |
| 運費規則 | 宅配且未滿 500 元收 60 元 | 規則相同 |
| 同一商品合併 | `merged[id]` | 用 `GROUP BY` 合併 |
| 品名、單價存成快照 | OrderItems 的「品名」「單價」 | `product_name`、`unit_price` |
| 訂單編號格式 | `JB` + 台北日期 `yyMMdd` + 3 碼流水號 | 格式相同，由 `next_order_no()` 產生 |
| 防重複送出 | `requestId`，存在 Cache 6 小時 | `request_id` 加 UNIQUE（見下方「新增或改變」） |
| 欄位驗證與錯誤訊息 | `parse_()` 的規則和中文訊息 | 規則和訊息相同 |
| 四種訂單狀態 | 已收到／製作中／可取餐／已完成 | `received`／`preparing`／`ready`／`completed` |
| 改狀態時記錄更新時間 | `onEdit` | `updated_at` trigger |
| 查詢要「編號＋電話」都相符，且不回傳個資 | `lookup_()` | `lookup_order()`，不回傳姓名、電話、地址 |

### 這次新增或改變的地方

- **狀態和取餐方式改存英文代碼**，中文由前端或 Edge Function 轉換。這樣改的是名稱，資料庫可以用 CHECK 限制合法值。
- **新增 `cancelled`（已取消）狀態。** 原專案沒有這個狀態。
- **防重複改成永久有效**：用 `request_id UNIQUE`，加上 advisory lock 處理同時送出的情況。原本只在 Cache 保留 6 小時。
- **流水號上限：** 單日超過 999 筆會直接報錯，不會像原程式那樣產生重複編號。
- **`created_at`／`updated_at` 改用 `timestamptz`**，明確包含時區。日期換日以 `Asia/Taipei` 計算。
- **`pickup_time` 改用 `time` 型別**，只存時分（例如 18:30），視為下單當天的台北時間。這和原本一樣沒有日期。
- **新增 `phone_digits`**：從電話自動產生的純數字欄位，用來比對查詢。
- **新增內部主鍵 `id`**（bigint identity），`order_no` 另外設成 UNIQUE。
- **不保留「品項摘要」欄位**，需要時從 `order_items` 組出來。
- **新增 `order_daily_seq` 表**，取代 ScriptProperties 存流水號。
- **新增 DB 層限制：** `total = subtotal + shipping_fee`、`line_total = unit_price × qty`、宅配一定要有地址。
- **安全設定：**
  - 四張表都啟用 RLS，而且**沒有建立任何 policy**，所以 anon 和 authenticated 一律被拒絕。
  - 撤銷 anon 和 authenticated 對這些表、序列、函式的權限（Supabase 預設會在 public schema 授權給它們）。
  - 只授權 `service_role` 使用。`service_role` 只能放在 Edge Function 的環境變數裡，**不能寫進前端**。
- **刻意不給的權限：** `order_items` 不給 UPDATE，而且四張表都不給 DELETE。

## 尚未完成的串接工作

1. **建立 Edge Function**（例如 `orders`）：
   - `POST`：呼叫 `create_order(payload)`。
   - `GET`：呼叫 `lookup_order(no, phone)`。
   - 錯誤處理：SQLSTATE `P0001` 的錯誤訊息直接回給前端，其他錯誤只回「系統發生錯誤，請稍後再試」。
   - 設定 CORS，並把狀態代碼轉成中文。
2. **修改前端：** `index.html` 的 `ORDER_ENDPOINT` 和 `order.html` 的查詢要改接 Edge Function。查詢結果的 `type`、`status` 現在是代碼，`createdAt` 是 ISO 時間，要轉成中文和 `yyyy-MM-dd HH:mm` 再顯示。
3. **店家改狀態的方式：** 原本直接在 Sheet 改，Supabase 版還沒有對應功能。可以先在 Supabase Table Editor 改 `orders.status`，之後再做店家後台。
4. **新訂單通知信**（原 `NOTIFY_EMAIL`）尚未實作。
5. **舊資料搬移：** Sheet 裡的訂單還沒搬進來。搬移時要處理這幾件事：
   - 中文狀態轉成代碼，舊值「新訂單」轉成 `received`、「可取餐／已出餐」轉成 `ready`。
   - 取餐方式的中文轉成代碼。
   - 去掉 `safe_()` 加在開頭的 `'`。
   - 確認試算表本身設定的時區。
   - 更新 `order_daily_seq`，讓流水號接續下去，避免和舊編號重複。
6. **前端商品資料仍寫死在 `index.html`**，改價時要同時改 `products` 表和 `index.html`，這點和原本一樣。
7. **防灌單：** 目前和原本一樣，只有欄位驗證和防重複，沒有驗證碼，也沒有限制同一支電話的下單頻率。
