/**
 * 金邊鍋貼｜訂單串接 Google Sheet（Google Apps Script）
 *
 * 使用方式請見 docs/GOOGLE_SHEETS_SETUP.md
 * 1. 在「已綁定 Google 試算表的 Apps Script」貼上本檔，執行一次 setup()
 * 2. 部署 → 新增部署作業 → 網頁應用程式（執行身分：我；存取：所有人）
 * 3. 把網址貼到 index.html 的 ORDER_ENDPOINT
 */

/* ===================== 設定 ===================== */
var CONFIG = {
  TIMEZONE: 'Asia/Taipei',
  ORDER_PREFIX: 'JB',
  SHIPPING_FEE: 60,          // 宅配運費
  FREE_SHIPPING_FROM: 500,   // 宅配滿額免運
  NOTIFY_EMAIL: '',          // 有新訂單時寄信給店家；留空代表不寄
  MAX_ITEMS: 50,
  MAX_QTY: 99
};

var SHEET = { ORDERS: 'Orders', ITEMS: 'OrderItems', PRODUCTS: 'Products' };
var STATUSES = ['已收到', '製作中', '可取餐', '已完成'];
// 舊版狀態文字 → 新狀態（查詢時對應，不改舊資料）
var LEGACY_STATUS = { '新訂單': '已收到', '可取餐／已出餐': '可取餐' };

var ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '姓名', '電話', '配送地址',
  '希望時間', '備註', '小計', '運費', '應付總額', '品項摘要', 'RequestId', '更新時間'];
var COL = { NO: 1, CREATED: 2, STATUS: 3, TYPE: 4, PHONE: 6, SUBTOTAL: 10, SHIPPING: 11, TOTAL: 12, UPDATED: 15 };
var ITEM_HEADERS = ['訂單編號', '商品ID', '品名', '單價', '數量', '小計'];
var PRODUCT_HEADERS = ['商品ID', '分類', '品名', '價格', '上架'];

var TYPE_LABEL = { dine: '內用', takeout: '外帶', delivery: '宅配' };

// 價格表種子資料：[id, 分類, 品名, 價格]（setup() 會寫入 Products 分頁，之後改價請直接改試算表）
var PRODUCTS_SEED = [
  ["p1", "signature", "招牌豬肉鍋貼（12 入）", 150],
  ["p2", "signature", "爆汁起司鍋貼（10 入）", 180],
  ["p3", "signature", "韭香辣味鍋貼（12 入）", 160],
  ["p4", "signature", "素食高麗菜鍋貼（12 入）", 140],
  ["p5", "dumpling", "手工高麗菜水餃（20 入）", 170],
  ["p6", "dumpling", "薑絲蛤蜊水餃（16 入）", 210],
  ["p7", "dumpling", "紅油抄手（14 入）", 190],
  ["p8", "soup", "酸辣湯", 80],
  ["p9", "soup", "老母雞湯", 120],
  ["p10", "soup", "冬瓜薏仁飲", 45],
  ["p11", "side", "涼拌小黃瓜", 60],
  ["p12", "side", "椒麻雞絲", 130],
  ["g1", "gift", "招牌招財鍋貼禮盒（50 入）", 1280],
  ["g2", "gift", "家庭分享禮盒（30 入）", 780]
];

/* ===================== 一次性初始化 ===================== */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var orders = getOrCreate_(ss, SHEET.ORDERS);
  ensureHeader_(orders, ORDER_HEADERS);
  orders.setFrozenRows(1);
  orders.getRange(2, 3, 1000, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  orders.getRange(2, 2, 1000, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  orders.getRange(2, 6, 1000, 1).setNumberFormat('@');   // 電話保留開頭 0
  orders.getRange(2, COL.UPDATED, 1000, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');

  var items = getOrCreate_(ss, SHEET.ITEMS);
  ensureHeader_(items, ITEM_HEADERS);
  items.setFrozenRows(1);

  var products = getOrCreate_(ss, SHEET.PRODUCTS);
  ensureHeader_(products, PRODUCT_HEADERS);
  products.setFrozenRows(1);
  if (products.getLastRow() < 2) {
    var rows = PRODUCTS_SEED.map(function (p) { return [p[0], p[1], p[2], p[3], true]; });
    products.getRange(2, 1, rows.length, 5).setValues(rows);
  }

  var first = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 3) ss.deleteSheet(first);
  SpreadsheetApp.flush();
}

/* ===================== Web App 入口 ===================== */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'order') {
    try {
      return json_(lookup_(p.no, p.phone));
    } catch (err) {
      if (err && err.userMessage) return json_({ ok: false, error: err.userMessage });
      console.error(err && err.stack ? err.stack : err);
      return json_({ ok: false, error: '系統發生錯誤，請稍後再試' });
    }
  }
  return json_({ ok: true, service: 'jinbian-orders' });
}

// 店家在 Orders 改「狀態」時，自動記錄更新時間（簡單觸發，不需另外設定）
function onEdit(e) {
  var r = e && e.range;
  if (!r || r.getSheet().getName() !== SHEET.ORDERS || r.getRow() < 2) return;
  if (r.getColumn() > COL.STATUS || r.getLastColumn() < COL.STATUS) return;
  r.getSheet().getRange(r.getRow(), COL.UPDATED, r.getNumRows(), 1).setValue(new Date());
}

/* ===================== 訂單查詢 ===================== */
var NOT_FOUND = '查無此訂單，請確認訂單編號與電話';

function digits_(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

function lookup_(no, phone) {
  no = String(no || '').trim().toUpperCase();
  var ph = digits_(phone);
  if (!/^[A-Z]{1,4}\d{9}$/.test(no)) fail_('請輸入正確的訂單編號');
  if (ph.length < 8) fail_('請輸入下單時的電話');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var orders = ss.getSheetByName(SHEET.ORDERS);
  var last = orders.getLastRow();
  if (last < 2) fail_(NOT_FOUND);
  var rows = orders.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  var row = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][COL.NO - 1]) === no) { row = rows[i]; break; }
  }
  // 訂單編號是流水號，必須電話相符才回傳，避免他人猜編號查看
  if (!row || digits_(row[COL.PHONE - 1]) !== ph) fail_(NOT_FOUND);

  var raw = String(row[COL.STATUS - 1] || '').trim();
  var status = LEGACY_STATUS[raw] || raw || STATUSES[0];

  var itemSheet = ss.getSheetByName(SHEET.ITEMS);
  var items = [];
  if (itemSheet.getLastRow() >= 2) {
    itemSheet.getRange(2, 1, itemSheet.getLastRow() - 1, ITEM_HEADERS.length).getValues().forEach(function (r) {
      if (String(r[0]) === no) items.push({ name: String(r[2]), price: Number(r[3]), qty: Number(r[4]) });
    });
  }

  var created = row[COL.CREATED - 1];
  var updated = row[COL.UPDATED - 1] || created;
  return {
    ok: true,
    orderNo: no,
    status: status,
    statusStep: STATUSES.indexOf(status),
    type: String(row[COL.TYPE - 1]),
    createdAt: fmtTime_(created),
    updatedAt: fmtTime_(updated),
    items: items,
    subtotal: Number(row[COL.SUBTOTAL - 1]),
    shipping: Number(row[COL.SHIPPING - 1]),
    total: Number(row[COL.TOTAL - 1])
  };
}

function fmtTime_(v) {
  return v instanceof Date ? Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm') : String(v || '');
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: '系統忙碌中，請稍後再試' });
  }
  try {
    var data = parse_(e);
    var cache = CacheService.getScriptCache();

    // 重複送出（連點、網路重試）：回傳同一個訂單編號
    var dup = cache.get('req_' + data.requestId);
    if (dup) return json_({ ok: true, orderNo: dup, duplicate: true });

    var priced = price_(data);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var orderNo = nextOrderNo_();
    var now = new Date();

    var summary = priced.items.map(function (i) { return i.name + ' x' + i.qty; }).join('、');
    ss.getSheetByName(SHEET.ORDERS).appendRow([
      orderNo, now, STATUSES[0], TYPE_LABEL[data.type], safe_(data.name), safe_(data.phone),
      safe_(data.address), safe_(data.time), safe_(data.note),
      priced.subtotal, priced.shipping, priced.total, summary, data.requestId, now
    ]);

    var itemSheet = ss.getSheetByName(SHEET.ITEMS);
    var itemRows = priced.items.map(function (i) {
      return [orderNo, i.id, i.name, i.price, i.qty, i.price * i.qty];
    });
    itemSheet.getRange(itemSheet.getLastRow() + 1, 1, itemRows.length, ITEM_HEADERS.length).setValues(itemRows);

    cache.put('req_' + data.requestId, orderNo, 21600);
    notify_(orderNo, data, priced, summary);

    return json_({ ok: true, orderNo: orderNo, total: priced.total });
  } catch (err) {
    if (err && err.userMessage) return json_({ ok: false, error: err.userMessage });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: '系統發生錯誤，請稍後再試' });
  } finally {
    lock.releaseLock();
  }
}

/* ===================== 驗證與計價 ===================== */
function fail_(msg) { var e = new Error(msg); e.userMessage = msg; throw e; }

function parse_(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { fail_('資料格式錯誤'); }

  var d = {
    requestId: String(body.requestId || '').slice(0, 64),
    type: String(body.type || ''),
    name: String(body.name || '').trim(),
    phone: String(body.phone || '').trim(),
    address: String(body.address || '').trim(),
    time: String(body.time || '').trim().slice(0, 10),
    note: String(body.note || '').trim().slice(0, 200),
    items: body.items
  };
  if (!/^[A-Za-z0-9\-]{8,64}$/.test(d.requestId)) fail_('缺少有效的訂單識別碼');
  if (!TYPE_LABEL[d.type]) fail_('取餐方式不正確');
  if (!d.name || d.name.length > 50) fail_('請輸入姓名');
  if (!/^[0-9+\-\s()]{8,15}$/.test(d.phone)) fail_('請輸入有效的聯絡電話');
  if (d.type === 'delivery' && (!d.address || d.address.length > 120)) fail_('宅配請填寫配送地址');
  if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > CONFIG.MAX_ITEMS) fail_('購物車是空的');
  return d;
}

function price_(d) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.PRODUCTS);
  var rows = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 5).getValues();
  var catalog = {};
  rows.forEach(function (r) {
    if (r[0] !== '' && r[4] === true) catalog[String(r[0])] = { name: String(r[2]), price: Number(r[3]) };
  });

  var merged = {};
  d.items.forEach(function (it) {
    var id = String(it && it.id || '');
    var qty = Number(it && it.qty);
    if (!catalog[id]) fail_('有商品已下架或不存在，請重新整理頁面後再試');
    if (!(qty >= 1 && qty <= CONFIG.MAX_QTY) || Math.floor(qty) !== qty) fail_('商品數量不正確');
    merged[id] = (merged[id] || 0) + qty;
  });

  var items = Object.keys(merged).map(function (id) {
    return { id: id, name: catalog[id].name, price: catalog[id].price, qty: merged[id] };
  });
  var subtotal = items.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
  var shipping = (d.type === 'delivery' && subtotal < CONFIG.FREE_SHIPPING_FROM) ? CONFIG.SHIPPING_FEE : 0;
  return { items: items, subtotal: subtotal, shipping: shipping, total: subtotal + shipping };
}

/* ===================== 工具 ===================== */
// 訂單編號：JB + 日期(yyMMdd) + 當日流水號（3 碼），例如 JB260115001。須在 lock 內呼叫。
function nextOrderNo_() {
  var props = PropertiesService.getScriptProperties();
  var day = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyMMdd');
  var key = 'seq_' + day;
  var seq = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(seq));
  return CONFIG.ORDER_PREFIX + day + ('00' + seq).slice(-3);
}

// 避免試算表公式注入：以 = + - @ 開頭的文字前面加單引號
function safe_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function notify_(orderNo, d, p, summary) {
  if (!CONFIG.NOTIFY_EMAIL) return;
  try {
    MailApp.sendEmail({
      to: CONFIG.NOTIFY_EMAIL,
      subject: '[金邊鍋貼] 新訂單 ' + orderNo + '（NT$ ' + p.total + '）',
      body: ['訂單編號：' + orderNo, '方式：' + TYPE_LABEL[d.type], '姓名：' + d.name, '電話：' + d.phone,
        d.address ? '地址：' + d.address : '', d.time ? '希望時間：' + d.time : '',
        '品項：' + summary, '應付總額：NT$ ' + p.total, d.note ? '備註：' + d.note : ''
      ].filter(Boolean).join('\n')
    });
  } catch (err) { console.error('寄信失敗：' + err); }   // 寄信失敗不影響訂單
}

function getOrCreate_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }

function ensureHeader_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#F3EADB');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
