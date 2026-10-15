// services/storage.js — GERÇEK SQLite depolama (better-sqlite3)
// Eski fonksiyon imzaları korundu: loadMemory, saveMemory, loadTriggers,
// saveTriggers, loadPortfolio, savePortfolio
// Yeni eklenenler: pozisyon, izleme listesi ve karar (decision) fonksiyonları.

const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '../data.sqlite'));
db.pragma('journal_mode = WAL');

// ---- Tablolar ----
db.exec(`
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS triggers (
  id INTEGER PRIMARY KEY,
  topic TEXT, symbol TEXT, operator TEXT, target REAL,
  status TEXT DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
  symbol TEXT PRIMARY KEY,
  qty REAL NOT NULL,
  avg_cost REAL NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY,
  added_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_date TEXT,
  symbol TEXT,
  action TEXT,
  amount REAL,
  stop_loss REAL,
  take_profit REAL,
  rationale TEXT,
  status TEXT DEFAULT 'pending',   -- pending | applied | rejected
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---- MEMORY (eski API ile uyumlu: dizi döner / dizi alır) ----
function loadMemory() {
  return db.prepare('SELECT data FROM memory ORDER BY id').all()
    .map(r => JSON.parse(r.data));
}
function saveMemory(arr) {
  const tx = db.transaction(items => {
    db.prepare('DELETE FROM memory').run();
    const ins = db.prepare('INSERT INTO memory (data) VALUES (?)');
    for (const it of items) ins.run(JSON.stringify(it));
  });
  tx(arr);
}

// Hata içeren AI yanıtlarını hafızaya yazmamak için filtre
function isErrorEntry(entry) {
  const text = JSON.stringify(entry).toLowerCase();
  return ['baglanti hatasi', 'bağlantı hatası', 'fetch failed', '"error"',
          'hata (claude)', 'hata (gpt)', 'hata (gemini)',
          'exceeded your current quota', 'quota exceeded', 'resource_exhausted',
          'not found for api version', 'no longer available',
          '⚠️ hata'].some(p => text.includes(p));
}
function appendMemory(entry, limit = 100) {
  if (isErrorEntry(entry)) {
    console.log('[MEMORY] Hata iceren kayit atlandi.');
    return false;
  }
  const mem = loadMemory();
  mem.push(entry);
  saveMemory(mem.slice(-limit));
  return true;
}

// ---- TRIGGERS (eski API ile uyumlu) ----
function loadTriggers() {
  return db.prepare('SELECT * FROM triggers').all();
}
function saveTriggers(arr) {
  const tx = db.transaction(items => {
    db.prepare('DELETE FROM triggers').run();
    const ins = db.prepare(
      'INSERT INTO triggers (id, topic, symbol, operator, target, status) VALUES (?,?,?,?,?,?)');
    const seen = new Set();
    for (const t of items) {
      const key = `${t.symbol}|${t.operator}|${t.target}|${t.status}`;
      if (seen.has(key)) continue; // ayni tetikleyiciyi iki kez kaydetme
      seen.add(key);
      ins.run(t.id || Date.now(), t.topic, t.symbol, t.operator, t.target, t.status || 'active');
    }
  });
  tx(arr);
}

// ---- PORTFOLIOS (eski API ile uyumlu) ----
// Strateji koddan gelir (DB'deki eski kopya ezilir), boylece ortak
// "uzun vadeli" kuralla celismez ve eski sabit dolar limitleri kalmaz.
const STRATEGY = 'Uzun vadeli (1+ yil) buyume odakli portfoy. KURALLAR: (1) Tek pozisyona toplam portfoy degerinin maksimum %25i girilebilir. (2) Karar gerekcesi sirket kalitesi, degerleme, buyume ve makro trend olmali; teknik sinyaller (RSI, MACD vb.) yalnizca giris/cikis zamanlamasi notudur, tek basina AL/SAT gerekcesi olamaz. (3) BEKLE karari veriyorsan hangi SOMUT kosul saglandiginda AL diyecegini belirt (ornek: belirli bir fiyat/degerleme esigi, bilancoda somut gelisme). (4) Kisa vadeli dalgalanma tek basina red sebebi degildir.';
const DEFAULT_PF = {
  midas: { id: 'midas', name: 'Portfoyum', cash: 0, positions: [], totalValue: 0, startValue: 0, strategy: STRATEGY }
};
function loadPortfolio(id) {
  const base = DEFAULT_PF[id] || DEFAULT_PF.midas;
  const row = db.prepare('SELECT data FROM portfolios WHERE id = ?').get(id);
  if (row) return { ...base, ...JSON.parse(row.data), strategy: base.strategy };
  return base;
}
function savePortfolio(id, data) {
  db.prepare(`INSERT INTO portfolios (id, data) VALUES (?, ?)
              ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
    .run(id, JSON.stringify(data));
}

// ---- POSITIONS (Midas pozisyonlari — elle senkronize) ----
function getPositions() {
  return db.prepare('SELECT * FROM positions ORDER BY symbol').all();
}
function upsertPosition(symbol, qty, avgCost) {
  db.prepare(`INSERT INTO positions (symbol, qty, avg_cost, updated_at)
              VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(symbol) DO UPDATE SET
                qty = excluded.qty, avg_cost = excluded.avg_cost,
                updated_at = datetime('now')`)
    .run(symbol.toUpperCase(), qty, avgCost);
}
function deletePosition(symbol) {
  return db.prepare('DELETE FROM positions WHERE symbol = ?')
    .run(symbol.toUpperCase()).changes > 0;
}

// ---- WATCHLIST ----
function getWatchlist() {
  return db.prepare('SELECT symbol FROM watchlist ORDER BY symbol').all().map(r => r.symbol);
}
function addWatch(symbol) {
  db.prepare('INSERT OR IGNORE INTO watchlist (symbol) VALUES (?)').run(symbol.toUpperCase());
}
function removeWatch(symbol) {
  return db.prepare('DELETE FROM watchlist WHERE symbol = ?')
    .run(symbol.toUpperCase()).changes > 0;
}

// ---- NOTES (kalici strateji notlari — /not komutu) ----
function addNote(text) {
  return db.prepare('INSERT INTO notes (text) VALUES (?)').run(text).lastInsertRowid;
}
function getNotes() {
  return db.prepare('SELECT * FROM notes ORDER BY id').all();
}
function deleteNote(id) {
  return db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0;
}

// ---- DECISIONS (sabah toplantisi kararlari, +/- takibi) ----
function addDecision(d) {
  const info = db.prepare(`INSERT INTO decisions
    (meeting_date, symbol, action, amount, stop_loss, take_profit, rationale)
    VALUES (?,?,?,?,?,?,?)`)
    .run(d.meetingDate, d.symbol, d.action, d.amount || null,
         d.stopLoss || null, d.takeProfit || null, d.rationale || '');
  return info.lastInsertRowid;
}
function getPendingDecisions() {
  return db.prepare("SELECT * FROM decisions WHERE status = 'pending' ORDER BY id").all();
}
function setDecisionStatus(id, status) {
  return db.prepare('UPDATE decisions SET status = ? WHERE id = ?')
    .run(status, id).changes > 0;
}
function getAllDecisions() {
  return db.prepare('SELECT * FROM decisions ORDER BY id DESC').all();
}
function getDecisionStats() {
  return db.prepare(`SELECT status, COUNT(*) AS n FROM decisions GROUP BY status`).all();
}

module.exports = {
  loadMemory, saveMemory, appendMemory, isErrorEntry,
  loadTriggers, saveTriggers,
  loadPortfolio, savePortfolio,
  getPositions, upsertPosition, deletePosition,
  getWatchlist, addWatch, removeWatch,
  addNote, getNotes, deleteNote,
  addDecision, getPendingDecisions, getAllDecisions, setDecisionStatus, getDecisionStats
};
