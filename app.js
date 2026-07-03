"use strict";

// ---------------------------------------------------------------------------
// データ管理
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ringo.books.v1";
const STALE_DAYS = 7; // この日数以上読んでいない本に「積読気味」バッジを出す

/** @typedef {"reading" | "paused" | "finished"} BookStatus */

const STATUS_LABELS = {
  reading: "読書中",
  paused: "中断中",
  finished: "読了",
};

function loadBooks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveBooks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
}

let books = loadBooks();
let currentFilter = "reading";

function createBook(fields) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    isbn: "",
    title: "",
    author: "",
    publisher: "",
    cover: "",
    currentPage: 0,
    totalPages: 0,
    status: "reading",
    notes: "",
    addedAt: now,
    lastReadAt: now,
    ...fields,
  };
}

function addBook(fields) {
  const book = createBook(fields);
  books.unshift(book);
  saveBooks();
  render();
  return book;
}

function updateBook(id, fields) {
  const book = books.find((b) => b.id === id);
  if (!book) return;
  Object.assign(book, fields);
  saveBooks();
  render();
}

function deleteBook(id) {
  books = books.filter((b) => b.id !== id);
  saveBooks();
  render();
}

// ---------------------------------------------------------------------------
// ISBN ユーティリティ
// ---------------------------------------------------------------------------

function normalizeIsbn(text) {
  return String(text).replace(/[^0-9Xx]/g, "").toUpperCase();
}

function isbn10to13(isbn10) {
  const core = "978" + isbn10.slice(0, 9);
  const sum = core
    .split("")
    .reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return core + ((10 - (sum % 10)) % 10);
}

/** 書籍のISBN(978/979始まりのEAN-13)として妥当か検証する */
function isValidIsbn13(code) {
  if (!/^97[89]\d{10}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const sum = digits
    .slice(0, 12)
    .reduce((s, d, i) => s + d * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}

/** 入力(ISBN-10/13どちらでも)をISBN-13に正規化。無効なら null */
function toIsbn13(text) {
  const code = normalizeIsbn(text);
  if (code.length === 10) {
    const isbn13 = isbn10to13(code);
    return isValidIsbn13(isbn13) ? isbn13 : null;
  }
  return isValidIsbn13(code) ? code : null;
}

// ---------------------------------------------------------------------------
// 書誌情報の取得 (openBD → Google Books の順で検索)
// ---------------------------------------------------------------------------

async function fetchBookInfo(isbn13) {
  const fromOpenBd = await fetchFromOpenBd(isbn13);
  if (fromOpenBd) return fromOpenBd;
  return fetchFromGoogleBooks(isbn13);
}

async function fetchFromOpenBd(isbn13) {
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn13}`);
    if (!res.ok) return null;
    const [entry] = await res.json();
    if (!entry) return null;
    const s = entry.summary || {};
    const extent =
      entry.onix?.DescriptiveDetail?.Extent?.find?.(
        (e) => e.ExtentType === "11"
      ) || null;
    return {
      isbn: isbn13,
      title: s.title || "",
      author: s.author || "",
      publisher: s.publisher || "",
      cover: s.cover || "",
      totalPages: extent ? Number(extent.ExtentValue) || 0 : 0,
    };
  } catch {
    return null;
  }
}

async function fetchFromGoogleBooks(isbn13) {
  try {
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const info = data.items?.[0]?.volumeInfo;
    if (!info) return null;
    return {
      isbn: isbn13,
      title: info.title || "",
      author: (info.authors || []).join(", "),
      publisher: info.publisher || "",
      cover: info.imageLinks?.thumbnail?.replace(/^http:/, "https:") || "",
      totalPages: info.pageCount || 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// バーコードスキャナ
// ---------------------------------------------------------------------------

const scannerDialog = document.getElementById("scanner-dialog");
const scannerVideo = document.getElementById("scanner-video");
const scannerStatus = document.getElementById("scanner-status");

let mediaStream = null;
let scanLoopId = null;
let zxingReader = null;
let scanHandled = false;

async function openScanner() {
  scanHandled = false;
  scannerDialog.showModal();
  setScannerStatus("カメラを起動しています…");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch (err) {
    setScannerStatus(
      "カメラを起動できませんでした。下の欄からISBNを直接入力してください。"
    );
    return;
  }
  scannerVideo.srcObject = mediaStream;
  await scannerVideo.play();

  if ("BarcodeDetector" in window) {
    startNativeDetector();
  } else {
    startZxingDetector();
  }
}

function setScannerStatus(text) {
  scannerStatus.textContent = text;
}

function startNativeDetector() {
  const detector = new BarcodeDetector({ formats: ["ean_13"] });
  setScannerStatus("バーコードを探しています…");
  const tick = async () => {
    if (!mediaStream) return;
    try {
      const codes = await detector.detect(scannerVideo);
      const hit = codes.find((c) => isValidIsbn13(c.rawValue));
      if (hit) {
        onIsbnDetected(hit.rawValue);
        return;
      }
    } catch {
      // 映像が準備できていないフレームは無視して次を試す
    }
    scanLoopId = setTimeout(tick, 150);
  };
  tick();
}

// BarcodeDetector 非対応ブラウザ(iOS Safari 等)向けに ZXing をCDNから読み込む
function startZxingDetector() {
  setScannerStatus("スキャナを読み込んでいます…");
  loadZxing()
    .then(() => {
      if (!mediaStream) return; // 読み込み中に閉じられた場合
      setScannerStatus("バーコードを探しています…");
      zxingReader = new ZXing.BrowserMultiFormatReader();
      zxingReader.decodeFromVideoElementContinuously(
        scannerVideo,
        (result) => {
          if (result && isValidIsbn13(result.getText())) {
            onIsbnDetected(result.getText());
          }
        }
      );
    })
    .catch(() => {
      setScannerStatus(
        "このブラウザではスキャンを利用できません。下の欄からISBNを直接入力してください。"
      );
    });
}

let zxingPromise = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  if (zxingPromise) return zxingPromise;
  zxingPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js";
    script.onload = () => resolve();
    script.onerror = () => {
      zxingPromise = null;
      reject(new Error("failed to load ZXing"));
    };
    document.head.appendChild(script);
  });
  return zxingPromise;
}

async function onIsbnDetected(isbn13) {
  if (scanHandled) return;
  scanHandled = true;
  stopScanner({ keepDialog: true });
  await registerByIsbn(isbn13);
}

function stopScanner({ keepDialog = false } = {}) {
  if (scanLoopId) {
    clearTimeout(scanLoopId);
    scanLoopId = null;
  }
  if (zxingReader) {
    zxingReader.reset();
    zxingReader = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  scannerVideo.srcObject = null;
  if (!keepDialog && scannerDialog.open) scannerDialog.close();
}

/** ISBNから書誌情報を引いて本を登録する(スキャン・手入力の共通経路) */
async function registerByIsbn(isbn13) {
  const existing = books.find((b) => b.isbn === isbn13);
  if (existing) {
    setScannerStatus(`「${existing.title}」はすでに登録されています。`);
    scanHandled = false;
    return;
  }

  setScannerStatus(`ISBN ${isbn13} の書誌情報を取得しています…`);
  const info = await fetchBookInfo(isbn13);

  if (info && info.title) {
    addBook({ ...info, status: "reading" });
    stopScanner();
    return;
  }

  // 書誌が見つからない場合は手動フォームにISBNだけ引き継ぐ
  stopScanner();
  openBookForm({ isbn: isbn13 });
}

// ---------------------------------------------------------------------------
// 本の追加・編集フォーム
// ---------------------------------------------------------------------------

const bookDialog = document.getElementById("book-dialog");
const bookForm = document.getElementById("book-form");

function openBookForm(book = {}) {
  document.getElementById("book-dialog-title").textContent = book.id
    ? "本を編集"
    : "本を追加";
  document.getElementById("book-id").value = book.id || "";
  document.getElementById("book-title").value = book.title || "";
  document.getElementById("book-author").value = book.author || "";
  document.getElementById("book-publisher").value = book.publisher || "";
  document.getElementById("book-isbn").value = book.isbn || "";
  document.getElementById("book-current-page").value = book.currentPage || 0;
  document.getElementById("book-total-pages").value = book.totalPages || 0;
  document.getElementById("book-notes").value = book.notes || "";
  bookDialog.showModal();
}

bookForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("book-id").value;
  const fields = {
    title: document.getElementById("book-title").value.trim(),
    author: document.getElementById("book-author").value.trim(),
    publisher: document.getElementById("book-publisher").value.trim(),
    isbn: normalizeIsbn(document.getElementById("book-isbn").value),
    currentPage: Math.max(0, Number(document.getElementById("book-current-page").value) || 0),
    totalPages: Math.max(0, Number(document.getElementById("book-total-pages").value) || 0),
    notes: document.getElementById("book-notes").value.trim(),
  };
  if (!fields.title) return;
  if (id) {
    updateBook(id, fields);
  } else {
    addBook(fields);
  }
  bookDialog.close();
});

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

const bookList = document.getElementById("book-list");
const emptyMessage = document.getElementById("empty-message");

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function daysSince(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

function visibleBooks() {
  const list =
    currentFilter === "all"
      ? books.slice()
      : books.filter((b) => b.status === currentFilter);
  if (currentFilter === "reading") {
    // 併読リストは「長く触れていない本」ほど上に出して読み残しを防ぐ
    list.sort((a, b) => new Date(a.lastReadAt) - new Date(b.lastReadAt));
  }
  return list;
}

const EMPTY_MESSAGES = {
  reading: "読書中の本はありません。「バーコードで追加」から本を登録しましょう。",
  paused: "中断中の本はありません。",
  finished: "読了した本はまだありません。",
  all: "登録された本はありません。「バーコードで追加」から本を登録しましょう。",
};

function render() {
  const list = visibleBooks();
  emptyMessage.classList.toggle("hidden", list.length > 0);
  emptyMessage.textContent = EMPTY_MESSAGES[currentFilter];
  bookList.innerHTML = list.map(renderBookCard).join("");
}

function renderBookCard(book) {
  const progress =
    book.totalPages > 0
      ? Math.min(100, Math.round((book.currentPage / book.totalPages) * 100))
      : 0;
  const stale = book.status === "reading" && daysSince(book.lastReadAt) >= STALE_DAYS;
  const cover = book.cover
    ? `<img class="book-cover" src="${escapeHtml(book.cover)}" alt="" loading="lazy">`
    : `<div class="book-cover-placeholder">📖</div>`;

  const meta = [book.author, book.publisher].filter(Boolean).join(" / ");
  const staleBadge = stale
    ? `<span class="stale-badge">${daysSince(book.lastReadAt)}日読んでいません</span>`
    : "";

  const progressRow =
    book.status === "finished"
      ? `<div class="progress-row"><div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div><span class="progress-label">読了 🎉</span></div>`
      : `<div class="progress-row">
          <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
          <input class="page-input" type="number" min="0" value="${book.currentPage}"
                 data-action="page" data-id="${book.id}" aria-label="現在のページ">
          <span class="progress-label">/ ${book.totalPages || "?"} p</span>
        </div>`;

  const statusButtons = {
    reading: `
      <button class="btn btn-small" data-action="pause" data-id="${book.id}">⏸ 中断</button>
      <button class="btn btn-small" data-action="finish" data-id="${book.id}">✅ 読了</button>`,
    paused: `
      <button class="btn btn-small" data-action="resume" data-id="${book.id}">▶️ 再開</button>
      <button class="btn btn-small" data-action="finish" data-id="${book.id}">✅ 読了</button>`,
    finished: `
      <button class="btn btn-small" data-action="resume" data-id="${book.id}">↩️ 読書中に戻す</button>`,
  }[book.status];

  return `
    <li class="book-card">
      ${cover}
      <div class="book-body">
        <h3 class="book-title">${escapeHtml(book.title)}${staleBadge}</h3>
        <p class="book-meta">${escapeHtml(meta)}${
          currentFilter === "all"
            ? ` <span class="stale-badge">${STATUS_LABELS[book.status]}</span>`
            : ""
        }</p>
        ${progressRow}
        ${book.notes ? `<p class="book-notes">${escapeHtml(book.notes)}</p>` : ""}
        <div class="book-actions">
          ${statusButtons}
          <button class="btn btn-small" data-action="edit" data-id="${book.id}">✏️ 編集</button>
          <button class="btn btn-small btn-danger" data-action="delete" data-id="${book.id}">🗑 削除</button>
        </div>
      </div>
    </li>`;
}

// ---------------------------------------------------------------------------
// スプレッドシート同期 (Google Apps Script 経由。設定手順は docs/sheets-sync-setup.md)
// ---------------------------------------------------------------------------

const SYNC_STORAGE_KEY = "ringo.sync.v1";

const syncDialog = document.getElementById("sync-dialog");
const syncStatus = document.getElementById("sync-status");
const syncConfigDetails = document.getElementById("sync-config");
const syncPushBtn = document.getElementById("sync-push");
const syncPullBtn = document.getElementById("sync-pull");

function loadSyncConfig() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSyncConfig(config) {
  localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(config));
}

function isSyncConfigured() {
  const config = loadSyncConfig();
  return Boolean(config.url && config.key);
}

function openSyncDialog() {
  const config = loadSyncConfig();
  document.getElementById("sync-url").value = config.url || "";
  document.getElementById("sync-key").value = config.key || "";
  updateSyncUi();
  syncDialog.showModal();
}

function updateSyncUi() {
  const configured = isSyncConfigured();
  syncPushBtn.disabled = !configured;
  syncPullBtn.disabled = !configured;
  syncConfigDetails.open = !configured;
  if (!configured) {
    setSyncStatus("最初に下の「接続設定」からURLと合言葉を設定してください。");
  } else {
    const { lastSyncAt } = loadSyncConfig();
    setSyncStatus(
      lastSyncAt
        ? `前回の同期: ${new Date(lastSyncAt).toLocaleString("ja-JP")}`
        : "設定済みです。保存または読み込みを実行できます。"
    );
  }
}

function setSyncStatus(text) {
  syncStatus.textContent = text;
}

async function callSheetApi(payload) {
  const { url, key } = loadSyncConfig();
  // Content-Type を text/plain にすると CORS のプリフライトが発生せず、
  // Apps Script のウェブアプリにそのまま届く
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ key, ...payload }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      "スプレッドシートからの応答を読み取れませんでした。URLとデプロイ設定(アクセス: 全員)を確認してください。"
    );
  }
  if (!data.ok) throw new Error(data.error || "不明なエラー");
  return data;
}

function markSynced() {
  const config = loadSyncConfig();
  config.lastSyncAt = new Date().toISOString();
  saveSyncConfig(config);
}

async function pushToSheet() {
  syncPushBtn.disabled = true;
  setSyncStatus("スプレッドシートに保存しています…");
  try {
    const data = await callSheetApi({ action: "save", books });
    markSynced();
    setSyncStatus(`✅ ${data.count}冊をスプレッドシートに保存しました。`);
  } catch (err) {
    setSyncStatus(`保存に失敗しました: ${err.message}`);
  } finally {
    syncPushBtn.disabled = false;
  }
}

async function pullFromSheet() {
  syncPullBtn.disabled = true;
  setSyncStatus("スプレッドシートから読み込んでいます…");
  try {
    const data = await callSheetApi({ action: "load" });
    const incoming = Array.isArray(data.books) ? data.books : [];
    const message =
      `スプレッドシートの${incoming.length}冊で、` +
      `この端末の${books.length}冊を置き換えます。よろしいですか?`;
    if (!confirm(message)) {
      setSyncStatus("読み込みをキャンセルしました。");
      return;
    }
    books = incoming;
    saveBooks();
    render();
    markSynced();
    setSyncStatus(`✅ ${incoming.length}冊を読み込みました。`);
  } catch (err) {
    setSyncStatus(`読み込みに失敗しました: ${err.message}`);
  } finally {
    syncPullBtn.disabled = false;
  }
}

document.getElementById("sync-btn").addEventListener("click", openSyncDialog);
document.getElementById("sync-close").addEventListener("click", () => syncDialog.close());
syncPushBtn.addEventListener("click", pushToSheet);
syncPullBtn.addEventListener("click", pullFromSheet);

document.getElementById("sync-config-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = document.getElementById("sync-url").value.trim();
  const key = document.getElementById("sync-key").value.trim();
  if (!url || !key) {
    setSyncStatus("URLと合言葉の両方を入力してください。");
    return;
  }
  const config = loadSyncConfig();
  saveSyncConfig({ ...config, url, key });
  syncConfigDetails.open = false;
  updateSyncUi();
  setSyncStatus("設定を保存しました。まず「スプレッドシートに保存」を試してください。");
});

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

document.getElementById("scan-btn").addEventListener("click", openScanner);
document
  .getElementById("manual-add-btn")
  .addEventListener("click", () => openBookForm());
document
  .getElementById("book-form-cancel")
  .addEventListener("click", () => bookDialog.close());
document
  .getElementById("scanner-close")
  .addEventListener("click", () => stopScanner());
scannerDialog.addEventListener("close", () => stopScanner());

document.getElementById("isbn-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("isbn-input");
  const isbn13 = toIsbn13(input.value);
  if (!isbn13) {
    setScannerStatus("ISBNの形式が正しくありません。数字を確認してください。");
    return;
  }
  input.value = "";
  await registerByIsbn(isbn13);
});

document.getElementById("filter-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  currentFilter = tab.dataset.filter;
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("active", t === tab));
  render();
});

bookList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const book = books.find((b) => b.id === id);
  if (!book) return;

  switch (action) {
    case "pause":
      updateBook(id, { status: "paused" });
      break;
    case "resume":
      updateBook(id, { status: "reading", lastReadAt: new Date().toISOString() });
      break;
    case "finish":
      updateBook(id, {
        status: "finished",
        currentPage: book.totalPages || book.currentPage,
        lastReadAt: new Date().toISOString(),
      });
      break;
    case "edit":
      openBookForm(book);
      break;
    case "delete":
      if (confirm(`「${book.title}」を削除しますか?`)) deleteBook(id);
      break;
  }
});

// ページ数の更新(進捗の記録 = 最終読書日の更新)
bookList.addEventListener("change", (e) => {
  const input = e.target.closest("input[data-action='page']");
  if (!input) return;
  const book = books.find((b) => b.id === input.dataset.id);
  if (!book) return;
  const page = Math.max(0, Number(input.value) || 0);
  updateBook(book.id, {
    currentPage: book.totalPages ? Math.min(page, book.totalPages) : page,
    lastReadAt: new Date().toISOString(),
  });
});

render();
