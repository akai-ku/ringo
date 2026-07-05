/**
 * ringo 併読ノート — Googleスプレッドシート同期用 Apps Script
 *
 * 設置手順は docs/sheets-sync-setup.md を参照してください。
 * このスクリプトをスプレッドシートの「拡張機能 → Apps Script」に貼り付けて、
 * ウェブアプリとしてデプロイすると、ringoアプリから本のデータを
 * 保存・読み込みできるようになります。
 */

// ★ 必ず自分だけの合言葉に変更してください(アプリの接続設定に入力するものと同じ)
const SECRET_KEY = "ここを自分の合言葉に変える";

const SHEET_NAME = "books";
const HEADERS = [
  "id",
  "isbn",
  "title",
  "author",
  "publisher",
  "cover",
  "currentPage",
  "totalPages",
  "status",
  "source",
  "notes",
  "addedAt",
  "lastReadAt",
  "startedAt",
  "endedAt",
];

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: "リクエストの形式が不正です" });
  }
  if (!req || req.key !== SECRET_KEY) {
    return json({ ok: false, error: "合言葉が一致しません" });
  }
  if (req.action === "save") return saveBooks(req.books || []);
  if (req.action === "load") return loadBooks();
  return json({ ok: false, error: "不明な操作です" });
}

/** アプリから送られた本の一覧でbooksシートを丸ごと書き換える */
function saveBooks(books) {
  const sheet = getSheet();
  sheet.clearContents();
  const rows = [HEADERS].concat(
    books.map(function (b) {
      return HEADERS.map(function (h) {
        return b[h] == null ? "" : b[h];
      });
    })
  );
  sheet.getRange(1, 1, rows.length, HEADERS.length).setValues(rows);
  return json({
    ok: true,
    count: books.length,
    savedAt: new Date().toISOString(),
  });
}

/** booksシートの内容を本の一覧として返す */
function loadBooks() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return json({ ok: true, books: [] });

  const headers = values[0].map(String);
  const books = values
    .slice(1)
    .filter(function (row) {
      return String(row[0]) !== "";
    })
    .map(function (row) {
      const b = {};
      headers.forEach(function (h, i) {
        b[h] = row[i];
      });
      b.id = String(b.id);
      b.isbn = b.isbn ? String(b.isbn) : "";
      b.title = String(b.title || "");
      b.author = String(b.author || "");
      b.publisher = String(b.publisher || "");
      b.cover = String(b.cover || "");
      b.notes = String(b.notes || "");
      b.status = String(b.status || "reading");
      b.source = String(b.source || "");
      b.currentPage = Number(b.currentPage) || 0;
      b.totalPages = Number(b.totalPages) || 0;
      b.addedAt = toIso(b.addedAt);
      b.lastReadAt = toIso(b.lastReadAt);
      b.startedAt = toDateStr(b.startedAt);
      b.endedAt = toDateStr(b.endedAt);
      return b;
    });
  return json({ ok: true, books: books });
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

/** スプレッドシートが日付として解釈した値もISO文字列に戻す */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const s = String(value || "");
  return s || new Date().toISOString();
}

/** YYYY-MM-DD 形式の文字列に戻す(空欄は空のまま) */
function toDateStr(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    );
  }
  return String(value || "").slice(0, 10);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
