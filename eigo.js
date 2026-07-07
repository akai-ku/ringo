"use strict";

// ---------------------------------------------------------------------------
// データ管理
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ringo.eigo.cards.v1";

// 間隔反復のレベルごとの復習間隔(日)。正解するたびにレベルが上がる
const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const MAX_LEVEL = INTERVALS.length - 1;

function loadCards() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
}

/** ローカル時刻での YYYY-MM-DD 文字列 */
function toLocalDateStr(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

let cards = loadCards();
let currentFilter = "due";

function createCard(fields) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    en: "",
    ja: "",
    addedAt: new Date().toISOString(),
    level: 0,
    dueAt: toLocalDateStr(), // 今日からすぐ復習対象
    reviews: 0,
    lapses: 0,
    ...fields,
  };
}

function addCard(fields) {
  const card = createCard(fields);
  cards.unshift(card);
  saveCards();
  return card;
}

function updateCard(id, fields) {
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  Object.assign(card, fields);
  saveCards();
  render();
}

function deleteCard(id) {
  cards = cards.filter((c) => c.id !== id);
  saveCards();
  render();
}

function dueCards() {
  const today = toLocalDateStr();
  return cards.filter((c) => c.dueAt <= today);
}

// ---------------------------------------------------------------------------
// テキストユーティリティ
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** チャンク区切りの / と // を色付きで表示するHTMLに変換 */
function chunkHtml(text) {
  let h = escapeHtml(text);
  h = h.replaceAll("//", "\u0000");
  h = h.replaceAll("/", '<span class="sep sep1">/</span>');
  h = h.replaceAll("\u0000", '<span class="sep sep2">//</span>');
  return h;
}

/** 読み上げ・発音判定用に、話者ラベル(A:)とスラッシュを取り除いた英文にする */
function speakableEnglish(en) {
  return en
    .replace(/^[A-D]\s*[::]\s*/, "")
    .replace(/\/+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 発音判定用に英文を単語の配列へ */
function tokenizeEnglish(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// OCRテキストの整形
// (サンプル教材: 「A: Good morning, / Mr. Tanaka. // Can I ask you / ...」形式)
// ---------------------------------------------------------------------------

/** 行の集まりを A:/B: の発話ごとに1行へまとめる。会話形式でなければ文単位に分割 */
function groupIntoTurns(rawText) {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    // 空行と、ページ端の行番号(5, 10, 15 …)だけの行を除く
    .filter((l) => l && !/^\d{1,3}$/.test(l));

  const isTurnStart = (l) => /^[A-DA-D]\s*[::]/.test(l);

  if (lines.some(isTurnStart)) {
    const turns = [];
    for (const line of lines) {
      if (isTurnStart(line) || turns.length === 0) {
        turns.push(line);
      } else {
        turns[turns.length - 1] += " " + line;
      }
    }
    return turns;
  }

  // 会話形式でない場合: つなげてから文末(. ! ?)で区切る
  const joined = lines.join(" ").replace(/\s+/g, " ");
  const sentences = joined.match(/[^.!?]+[.!?]+["”’]?/g);
  return sentences ? sentences.map((s) => s.trim()) : joined ? [joined] : [];
}

function cleanOcrEnglish(raw) {
  const text = raw
    .replace(/-\n/g, "") // 行末ハイフンの単語をつなげる
    .replace(/[|]/g, "/") // OCRが / を | と誤認することがある
    .replace(/[ \t]+/g, " ");
  return groupIntoTurns(text)
    .map((t) =>
      t
        .replace(/\/\s*\//g, "\u0000") // // をいったん退避
        .replace(/\s*\/\s*/g, " / ")
        .replace(/\s*\u0000\s*/g, " // ")
        .replace(/\s+/g, " ")
        .replace(/([.!?])\s+\d{1,2}$/, "$1") // 文末に残ったページ余白の行番号を除く
        .trim()
    )
    .join("\n");
}

/** 日本語文字のあいだに入ったOCR由来の空白を除く */
function removeJaSpaces(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/([^\x00-\x7F]) +(?=[^\x00-\x7F])/g, "$1");
  } while (s !== prev);
  return s;
}

function cleanOcrJapanese(raw) {
  const text = raw.replace(/[|]/g, "/").replace(/[ \t]+/g, " ");
  return groupIntoTurns(text)
    .map((t) => removeJaSpaces(t).trim())
    .join("\n");
}

// ---------------------------------------------------------------------------
// 自動翻訳 (MyMemory API: 無料・キー不要)
// ---------------------------------------------------------------------------

async function translateEnToJa(text) {
  const query = speakableEnglish(text);
  if (!query) return "";
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=en|ja`
    );
    if (!res.ok) return "";
    const data = await res.json();
    const t = data?.responseData?.translatedText || "";
    if (!t || /MYMEMORY WARNING/i.test(t)) return "";
    return t;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// トースト
// ---------------------------------------------------------------------------

const toastEl = document.getElementById("toast");
let toastTimer = null;

function showToast(text, duration = 4000) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), duration);
}

// ---------------------------------------------------------------------------
// 写真読み取り (Tesseract.js をCDNから遅延読み込み)
// ---------------------------------------------------------------------------

const OCR_MAX_DIM = 2000; // 大きすぎる写真は縮小して読み取りを速くする

let tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = () => resolve();
    script.onerror = () => {
      tesseractPromise = null;
      reject(new Error("failed to load tesseract.js"));
    };
    document.head.appendChild(script);
  });
  return tesseractPromise;
}

async function fileToCanvas(file) {
  // createImageBitmap はEXIFの向きを反映してくれる
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, OCR_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

function rotateCanvas(canvas) {
  const rotated = document.createElement("canvas");
  rotated.width = canvas.height;
  rotated.height = canvas.width;
  const ctx = rotated.getContext("2d");
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return rotated;
}

/**
 * 写真読み取りのセクション(英語/日本語)をひとつ組み立てる。
 * 写真選択 → プレビュー(回転可) → OCR → テキストエリアへ、の流れを共通化
 */
function setupOcrSection({ lang, cameraId, fileId, rotateId, ocrBtnId, previewWrapId, progressId, progressFillId, statusId, textareaId, clean }) {
  const rotateBtn = document.getElementById(rotateId);
  const ocrBtn = document.getElementById(ocrBtnId);
  const previewWrap = document.getElementById(previewWrapId);
  const progress = document.getElementById(progressId);
  const progressFill = document.getElementById(progressFillId);
  const status = document.getElementById(statusId);
  const textarea = document.getElementById(textareaId);

  let canvas = null;

  async function onPick(file) {
    if (!file) return;
    try {
      canvas = await fileToCanvas(file);
    } catch {
      showToast("写真を読み込めませんでした。別の写真で試してください。", 6000);
      return;
    }
    showPreview();
    rotateBtn.classList.remove("hidden");
    ocrBtn.classList.remove("hidden");
    status.textContent = "文字が横向きなら「↻ 回転」で直してから「🔍 読み取る」を押してください。";
    progress.classList.remove("hidden");
    progressFill.style.width = "0%";
  }

  function showPreview() {
    previewWrap.innerHTML = "";
    previewWrap.appendChild(canvas);
    previewWrap.classList.remove("hidden");
  }

  rotateBtn.addEventListener("click", () => {
    if (!canvas) return;
    canvas = rotateCanvas(canvas);
    showPreview();
  });

  ocrBtn.addEventListener("click", async () => {
    if (!canvas) return;
    ocrBtn.disabled = true;
    rotateBtn.disabled = true;
    progress.classList.remove("hidden");
    status.textContent = "読み取りの準備をしています…(初回は少し時間がかかります)";
    try {
      await loadTesseract();
      const result = await Tesseract.recognize(canvas, lang, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            progressFill.style.width = `${Math.round(m.progress * 100)}%`;
            status.textContent = `文字を読み取っています… ${Math.round(m.progress * 100)}%`;
          }
        },
      });
      const cleaned = clean(result.data.text || "");
      if (!cleaned) {
        status.textContent = "文字を読み取れませんでした。写真の向きや明るさを変えて試してください。";
      } else {
        textarea.value = cleaned;
        status.textContent = "読み取りました。下のテキストを確認して、必要なら直してください。";
      }
    } catch {
      status.textContent = "読み取りに失敗しました。通信環境を確認してもう一度試してください。";
    } finally {
      ocrBtn.disabled = false;
      rotateBtn.disabled = false;
    }
  });

  for (const inputId of [cameraId, fileId]) {
    document.getElementById(inputId).addEventListener("change", (e) => {
      onPick(e.target.files[0]);
      e.target.value = ""; // 同じ写真をもう一度選べるように
    });
  }
}

setupOcrSection({
  lang: "eng",
  cameraId: "photo-en-camera",
  fileId: "photo-en-file",
  rotateId: "rotate-en-btn",
  ocrBtnId: "ocr-en-btn",
  previewWrapId: "preview-en-wrap",
  progressId: "progress-en",
  progressFillId: "progress-en-fill",
  statusId: "status-en",
  textareaId: "ocr-en-text",
  clean: cleanOcrEnglish,
});

setupOcrSection({
  lang: "jpn",
  cameraId: "photo-ja-camera",
  fileId: "photo-ja-file",
  rotateId: "rotate-ja-btn",
  ocrBtnId: "ocr-ja-btn",
  previewWrapId: "preview-ja-wrap",
  progressId: "progress-ja",
  progressFillId: "progress-ja-fill",
  statusId: "status-ja",
  textareaId: "ocr-ja-text",
  clean: cleanOcrJapanese,
});

// ---------------------------------------------------------------------------
// 写真ダイアログ: 読み取った英文・日本語訳をカードとして登録
// ---------------------------------------------------------------------------

const photoDialog = document.getElementById("photo-dialog");
const ocrRegisterBtn = document.getElementById("ocr-register-btn");

document.getElementById("photo-add-btn").addEventListener("click", () => {
  photoDialog.showModal();
});
document.getElementById("photo-close").addEventListener("click", () => photoDialog.close());

ocrRegisterBtn.addEventListener("click", async () => {
  const enLines = document
    .getElementById("ocr-en-text")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const jaLines = document
    .getElementById("ocr-ja-text")
    .value.split("\n")
    .map((l) => l.trim());
  const autoTranslate = document.getElementById("ocr-auto-translate").checked;

  if (enLines.length === 0) {
    showToast("登録する英文がありません。写真を読み取るか、直接入力してください。", 6000);
    return;
  }

  // すでに同じ英文があるカードは重複登録しない
  const existing = new Set(cards.map((c) => speakableEnglish(c.en).toLowerCase()));
  const newEntries = [];
  let skipped = 0;
  for (let i = 0; i < enLines.length; i++) {
    if (existing.has(speakableEnglish(enLines[i]).toLowerCase())) {
      skipped++;
      continue;
    }
    newEntries.push({ en: enLines[i], ja: (jaLines[i] || "").trim() });
  }

  if (newEntries.length === 0) {
    showToast(`すべて登録済みの英文でした(${skipped}件)。`, 6000);
    return;
  }

  ocrRegisterBtn.disabled = true;

  const untranslated = newEntries.filter((e) => !e.ja);
  if (autoTranslate && untranslated.length > 0) {
    showToast(`🌐 ${untranslated.length}件の日本語訳を取得しています…`, 60000);
    for (const entry of untranslated) {
      entry.ja = await translateEnToJa(entry.en);
      await new Promise((r) => setTimeout(r, 300)); // APIへの連続アクセスを控えめに
    }
  }

  for (const entry of newEntries.reverse()) {
    addCard(entry); // unshift なので逆順に入れて元の順を保つ
  }

  ocrRegisterBtn.disabled = false;
  render();
  photoDialog.close();
  document.getElementById("ocr-en-text").value = "";
  document.getElementById("ocr-ja-text").value = "";
  showToast(
    `✅ ${newEntries.length}枚のカードを登録しました。` +
      (skipped ? `(登録済み${skipped}件はスキップ)` : "")
  );
});

// ---------------------------------------------------------------------------
// カードの追加・編集フォーム
// ---------------------------------------------------------------------------

const cardDialog = document.getElementById("card-dialog");
const cardForm = document.getElementById("card-form");
const cardFormStatus = document.getElementById("card-form-status");

function openCardForm(card = {}) {
  document.getElementById("card-dialog-title").textContent = card.id
    ? "カードを編集"
    : "カードを追加";
  document.getElementById("card-id").value = card.id || "";
  document.getElementById("card-en").value = card.en || "";
  document.getElementById("card-ja").value = card.ja || "";
  cardFormStatus.textContent = "";
  cardDialog.showModal();
}

cardForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("card-id").value;
  const fields = {
    en: document.getElementById("card-en").value.trim(),
    ja: document.getElementById("card-ja").value.trim(),
  };
  if (!fields.en) return;
  if (id) {
    updateCard(id, fields);
  } else {
    addCard(fields);
    render();
  }
  cardDialog.close();
});

document.getElementById("manual-add-btn").addEventListener("click", () => openCardForm());
document.getElementById("card-form-cancel").addEventListener("click", () => cardDialog.close());

document.getElementById("card-translate-btn").addEventListener("click", async (e) => {
  const en = document.getElementById("card-en").value.trim();
  if (!en) {
    cardFormStatus.textContent = "先に英文を入力してください。";
    return;
  }
  e.target.disabled = true;
  cardFormStatus.textContent = "🌐 翻訳しています…";
  const ja = await translateEnToJa(en);
  e.target.disabled = false;
  if (ja) {
    document.getElementById("card-ja").value = ja;
    cardFormStatus.textContent = "翻訳しました。不自然なところは直してください。";
  } else {
    cardFormStatus.textContent = "翻訳を取得できませんでした。手で入力してください。";
  }
});

// ---------------------------------------------------------------------------
// 一覧表示
// ---------------------------------------------------------------------------

const cardList = document.getElementById("card-list");
const emptyMessage = document.getElementById("empty-message");
const studySummary = document.getElementById("study-summary");

const EMPTY_MESSAGES = {
  due: "今日の復習はありません 🎉 「📷 写真から追加」で英文を増やしましょう。",
  all: "カードがまだありません。「📷 写真から追加」で英文を登録しましょう。",
};

function levelLabel(card) {
  if (card.reviews === 0) return "🌱 新規";
  return `Lv.${card.level}`;
}

function dueLabel(card) {
  const today = toLocalDateStr();
  if (card.dueAt <= today) return `<span class="due-badge">今日復習</span>`;
  return "";
}

function render() {
  const due = dueCards();
  studySummary.textContent = `今日の復習: ${due.length}枚 / 全${cards.length}枚`;

  let list;
  if (currentFilter === "due") {
    list = due.slice().sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  } else {
    list = cards.slice();
  }

  emptyMessage.classList.toggle("hidden", list.length > 0);
  emptyMessage.textContent = EMPTY_MESSAGES[currentFilter];
  cardList.innerHTML = list.map(renderCard).join("");
}

function renderCard(card) {
  const nextInfo =
    card.dueAt > toLocalDateStr() ? `次回 ${card.dueAt.replaceAll("-", "/")}` : "";
  return `
    <li class="eigo-card">
      <p class="eigo-card-en">${chunkHtml(card.en)}${dueLabel(card)}</p>
      ${card.ja ? `<p class="eigo-card-ja">${chunkHtml(card.ja)}</p>` : ""}
      <p class="eigo-card-meta">
        <span class="level-badge">${levelLabel(card)}</span>
        ${nextInfo}
      </p>
      <div class="book-actions">
        <button class="btn btn-small" data-action="speak" data-id="${card.id}">🔊 聞く</button>
        <button class="btn btn-small" data-action="edit" data-id="${card.id}">✏️ 編集</button>
        <button class="btn btn-small btn-danger" data-action="delete" data-id="${card.id}">🗑 削除</button>
      </div>
    </li>`;
}

cardList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  switch (action) {
    case "speak":
      speak(speakableEnglish(card.en));
      break;
    case "edit":
      openCardForm(card);
      break;
    case "delete":
      if (confirm("このカードを削除しますか?\n" + card.en)) deleteCard(id);
      break;
  }
});

document.getElementById("filter-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  currentFilter = tab.dataset.filter;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  render();
});

// ---------------------------------------------------------------------------
// 音声読み上げ (Web Speech API: speechSynthesis)
// ---------------------------------------------------------------------------

let voices = [];
function refreshVoices() {
  voices = speechSynthesis.getVoices();
}
if ("speechSynthesis" in window) {
  refreshVoices();
  speechSynthesis.addEventListener("voiceschanged", refreshVoices);
}

function pickEnglishVoice() {
  return (
    voices.find((v) => v.lang === "en-US" && v.localService) ||
    voices.find((v) => v.lang === "en-US") ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null
  );
}

function speak(text, rate = 1.0) {
  if (!("speechSynthesis" in window)) {
    showToast("このブラウザは読み上げに対応していません。", 6000);
    return;
  }
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  const voice = pickEnglishVoice();
  if (voice) utter.voice = voice;
  utter.rate = rate;
  speechSynthesis.speak(utter);
}

// ---------------------------------------------------------------------------
// 発音チェック (Web Speech API: SpeechRecognition)
// ---------------------------------------------------------------------------

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

const recordBtn = document.getElementById("record-btn");
const pronResult = document.getElementById("pron-result");

function stopRecognition() {
  if (recognition) {
    try {
      recognition.abort();
    } catch {}
    recognition = null;
  }
  recordBtn.classList.remove("record-btn-active");
  recordBtn.textContent = "🎤 発音チェック";
}

/** 目標の単語列に対して、話した単語列が最長でどれだけ一致するか(LCS)を単語ごとに求める */
function matchWords(target, spoken) {
  const n = target.length;
  const m = spoken.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        target[i] === spoken[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const flags = new Array(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (target[i] === spoken[j]) {
      flags[i] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return flags;
}

function showPronResult(targetText, spokenText) {
  const targetWords = tokenizeEnglish(targetText);
  const spokenWords = tokenizeEnglish(spokenText);
  const flags = matchWords(targetWords, spokenWords);
  const hit = flags.filter(Boolean).length;
  const score = targetWords.length ? Math.round((hit / targetWords.length) * 100) : 0;

  const message =
    score >= 90 ? "すばらしい発音です!" :
    score >= 70 ? "いい感じ!赤い単語をもう一度。" :
    score >= 40 ? "おしい!ゆっくり区切って言ってみましょう。" :
    "もう一度チャレンジ。🔊で聞いてから真似してみてください。";

  const wordsHtml = targetWords
    .map(
      (w, idx) =>
        `<span class="pron-word ${flags[idx] ? "hit" : "miss"}">${escapeHtml(w)}</span>`
    )
    .join("");

  pronResult.innerHTML = `
    <p class="pron-score">🎯 ${score}点 — ${escapeHtml(message)}</p>
    <p class="pron-words">${wordsHtml}</p>
    <p class="pron-heard">聞き取られた音声: ${spokenText ? escapeHtml(spokenText) : "(認識できませんでした)"}</p>`;
  pronResult.classList.remove("hidden");
}

function startPronunciationCheck(targetText) {
  if (!SpeechRecognitionCtor) {
    showToast("このブラウザは音声認識に対応していません(ChromeやSafariでお試しください)。", 7000);
    return;
  }
  if (recognition) {
    stopRecognition();
    return;
  }
  window.speechSynthesis?.cancel();

  recognition = new SpeechRecognitionCtor();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 5;

  recordBtn.classList.add("record-btn-active");
  recordBtn.textContent = "⏹ 話し終えたらタップ";
  pronResult.classList.add("hidden");

  recognition.onresult = (event) => {
    // 候補の中からいちばんスコアが高くなる聞き取り結果を採用する
    const alternatives = Array.from(event.results[0]);
    const targetWords = tokenizeEnglish(targetText);
    let best = alternatives[0]?.transcript || "";
    let bestScore = -1;
    for (const alt of alternatives) {
      const flags = matchWords(targetWords, tokenizeEnglish(alt.transcript));
      const score = flags.filter(Boolean).length;
      if (score > bestScore) {
        bestScore = score;
        best = alt.transcript;
      }
    }
    showPronResult(targetText, best);
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("マイクの使用が許可されていません。ブラウザの設定を確認してください。", 7000);
    } else if (event.error !== "aborted") {
      showPronResult(targetText, "");
    }
  };
  recognition.onend = () => {
    recognition = null;
    recordBtn.classList.remove("record-btn-active");
    recordBtn.textContent = "🎤 発音チェック";
  };

  try {
    recognition.start();
  } catch {
    stopRecognition();
  }
}

// ---------------------------------------------------------------------------
// 復習セッション (間隔反復)
// ---------------------------------------------------------------------------

const practiceDialog = document.getElementById("practice-dialog");
const practicePrompt = document.getElementById("practice-prompt");
const practiceHint = document.getElementById("practice-hint");
const practiceAnswer = document.getElementById("practice-answer");
const practiceAnswerMain = document.getElementById("practice-answer-main");
const practiceProgress = document.getElementById("practice-progress");
const practiceTools = document.getElementById("practice-tools");
const revealBtn = document.getElementById("reveal-btn");
const gradeButtons = document.getElementById("grade-buttons");

let queue = [];
let sessionTotal = 0;
let doneCount = 0;
let currentCard = null;
let practiceMode = "ja-en"; // "ja-en" = 日本語を見て英語を思い出す

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function startPractice() {
  let targets = dueCards();
  if (targets.length === 0) {
    if (cards.length === 0) {
      showToast("カードがまだありません。まず英文を登録しましょう。", 6000);
      return;
    }
    if (!confirm("今日の復習はありません 🎉\nすべてのカードから練習しますか?")) return;
    targets = cards.slice();
  }
  queue = shuffle(targets.slice());
  sessionTotal = queue.length;
  doneCount = 0;
  practiceDialog.showModal();
  showNextCard();
}

function showNextCard() {
  stopRecognition();
  window.speechSynthesis?.cancel();
  if (queue.length === 0) {
    practiceDialog.close();
    showToast(`🎉 復習おわり!${sessionTotal}枚がんばりました。`);
    render();
    return;
  }
  currentCard = queue[0];
  practiceProgress.textContent = `${doneCount + 1} / ${sessionTotal}`;
  pronResult.classList.add("hidden");
  practiceAnswer.classList.add("hidden");
  gradeButtons.classList.add("hidden");
  revealBtn.classList.remove("hidden");

  if (practiceMode === "ja-en") {
    practiceHint.textContent = "🇯🇵 → 🇬🇧 日本語を見て、英語で言ってみましょう";
    practicePrompt.innerHTML = currentCard.ja
      ? chunkHtml(currentCard.ja)
      : "(日本語訳が未登録のカードです。答えを見て覚えましょう)";
    practiceTools.classList.add("hidden"); // 答えが英語なので、答えを見るまで隠す
  } else {
    practiceHint.textContent = "🇬🇧 → 🇯🇵 英語を読んで、意味を思い出しましょう";
    practicePrompt.innerHTML = chunkHtml(currentCard.en);
    practiceTools.classList.remove("hidden"); // 英語が見えているので発音練習もできる
  }
}

function reveal() {
  if (!currentCard) return;
  practiceAnswer.classList.remove("hidden");
  practiceAnswerMain.innerHTML =
    practiceMode === "ja-en"
      ? chunkHtml(currentCard.en)
      : currentCard.ja
        ? chunkHtml(currentCard.ja)
        : "(日本語訳が未登録です。✏️ 編集から追加できます)";
  practiceTools.classList.remove("hidden");
  revealBtn.classList.add("hidden");
  gradeButtons.classList.remove("hidden");
}

function grade(result) {
  if (!currentCard) return;
  const card = currentCard;
  queue.shift();

  card.reviews = (card.reviews || 0) + 1;
  if (result === "again") {
    card.level = 0;
    card.lapses = (card.lapses || 0) + 1;
    card.dueAt = toLocalDateStr();
    queue.push(card); // このセッション中にもう一度出す
  } else {
    const step = result === "easy" ? 2 : 1;
    card.level = Math.min(MAX_LEVEL, (card.level || 0) + step);
    card.dueAt = addDays(toLocalDateStr(), INTERVALS[card.level]);
    doneCount++;
  }
  card.lastReviewedAt = new Date().toISOString();
  saveCards();
  showNextCard();
}

document.getElementById("practice-start-btn").addEventListener("click", startPractice);
revealBtn.addEventListener("click", reveal);

gradeButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-grade]");
  if (btn) grade(btn.dataset.grade);
});

document.getElementById("mode-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  practiceMode = btn.dataset.mode;
  document
    .querySelectorAll(".mode-btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
  if (currentCard) showNextCard(); // 表示中のカードを新しいモードで出し直す
});

document.getElementById("speak-btn").addEventListener("click", () => {
  if (currentCard) speak(speakableEnglish(currentCard.en));
});
document.getElementById("speak-slow-btn").addEventListener("click", () => {
  if (currentCard) speak(speakableEnglish(currentCard.en), 0.6);
});
recordBtn.addEventListener("click", () => {
  if (currentCard) startPronunciationCheck(speakableEnglish(currentCard.en));
});

document.getElementById("practice-close").addEventListener("click", () => {
  practiceDialog.close();
});
practiceDialog.addEventListener("close", () => {
  stopRecognition();
  window.speechSynthesis?.cancel();
  currentCard = null;
  render();
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

render();
