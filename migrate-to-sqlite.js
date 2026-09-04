// migrate-to-sqlite.js — Eski JSON dosyalarini GERCEK SQLite'a tasir.
// Ayrica: hata iceren memory kayitlarini ve "500 dolar" donemine ait
// eski kayitlari temizler, cift tetikleyicileri ayiklar.
// Calistir: node migrate-to-sqlite.js

const fs = require('fs');
const path = require('path');
const {
  saveMemory, saveTriggers, savePortfolio, isErrorEntry
} = require('./services/storage');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); }
  catch (e) { return fallback; }
}

console.log('SQLite aktarimi basliyor...\n');

// --- MEMORY: hatali ve eski "500 dolar" kayitlarini filtrele ---
const memory = readJSON('memory.json', []);
const cleaned = memory.filter(m => {
  if (isErrorEntry(m)) return false;                          // API hatasi iceren kayitlar
  const t = (m.topic || '').toLowerCase();
  if (t.includes('500 dolar')) return false;                  // eski bakiye donemine ait konu
  return true;
});
if (cleaned.length || memory.length) {
  saveMemory(cleaned);
  console.log(`memory.json aktarildi: ${memory.length} kayittan ${cleaned.length} temiz kayit.`);
  console.log(`  (${memory.length - cleaned.length} hatali/eski kayit filtrelendi)`);
} else {
  console.log('memory.json bos, atlandi.');
}

// --- TRIGGERS: saveTriggers zaten dedup yapiyor ---
const triggers = readJSON('triggers.json', []);
if (triggers.length) {
  saveTriggers(triggers);
  console.log('triggers.json aktarildi (cift kayitlar ayiklandi).');
} else {
  console.log('triggers.json bos, atlandi.');
}

// --- PORTFOLIOS ---
for (const id of ['a', 'b']) {
  const pf = readJSON(`portfolio-${id}.json`, null);
  if (pf) { savePortfolio(id, pf); console.log(`portfolio-${id}.json aktarildi.`); }
}

console.log('\nTamamlandi! data.sqlite dosyasi olustu/guncellendi.');
console.log('Kontrol: node -e "const s=require(\'./services/storage\');console.log(s.loadMemory().length,\'memory kaydi\')"');
console.log('\nNOT: Eski portfolio.json (cash:500) hicbir yerde kullanilmiyor, silebilirsin.');
console.log('Midas pozisyonlarini eklemek icin Telegram\'dan: /portfoy SEMBOL ADET MALIYET');
