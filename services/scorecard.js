// services/scorecard.js — KOMITE KARNESI (/karne)
// Amac: komite isine yariyor mu? Her kararin verildigi gunku kapanis fiyati
// ile bugunku fiyat karsilastirilir.
// Dogru sayilma kurali:
//   AL / TUT  -> fiyat yukselmisse dogru (elde tutmak / almak kazandirdi)
//   SAT / BEKLE -> fiyat dusmusse dogru (satmak / almamak zarardan korudu)
// Sembol olmayan kararlar (MEVCUT_PORTFOY, IZLEME_LISTESI vb.) atlanir;
// "VST, SOFI, RKLB" gibi coklu sembollerde her biri ayri degerlendirilir.

const { getAllDecisions } = require('./storage');
const { fetchQuote } = require('./marketData');

// Kararin verildigi gunun (veya sonraki ilk islem gununun) kapanis fiyati
async function closeOnDate(symbol, createdAt) {
  try {
    const start = Math.floor(new Date(createdAt.slice(0, 10) + 'T00:00:00Z').getTime() / 1000);
    const end = start + 7 * 24 * 3600;
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${start}&period2=${end}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = await r.json();
    const closes = d.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const first = closes.find(c => c != null);
    return first ? Number(first) : null;
  } catch (e) { return null; }
}

function splitSymbols(raw) {
  return String(raw || '').split(/[,\s/]+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) && !s.includes('_'));
}

async function buildScorecard() {
  const decisions = getAllDecisions().slice().reverse(); // eskiden yeniye
  const rows = [];
  const priceCache = {};
  const tooRecent = Date.now() - 5 * 24 * 3600 * 1000;
  let skipped = 0;

  for (const d of decisions) {
    const action = String(d.action || '').toUpperCase();
    if (!['AL', 'SAT', 'TUT', 'BEKLE'].includes(action)) continue;
    if (new Date(d.created_at.replace(' ', 'T') + 'Z').getTime() > tooRecent) { skipped++; continue; }
    for (const sym of splitSymbols(d.symbol)) {
      const then = await closeOnDate(sym, d.created_at);
      if (!(sym in priceCache)) priceCache[sym] = (await fetchQuote(sym))?.price || null;
      const now = priceCache[sym];
      if (!then || !now) continue;
      const chg = ((now - then) / then) * 100;
      const correct = (action === 'AL' || action === 'TUT') ? chg > 0 : chg < 0;
      // Ayni donemde genel piyasa (SPY) ne yapti? Herkesin dustugu donemde BEKLE kolay dogru cikar.
      if (!priceCache['SPY@' + d.created_at.slice(0, 10)]) priceCache['SPY@' + d.created_at.slice(0, 10)] = await closeOnDate('SPY', d.created_at);
      const spyThen = priceCache['SPY@' + d.created_at.slice(0, 10)];
      if (!('SPY' in priceCache)) priceCache.SPY = (await fetchQuote('SPY'))?.price || null;
      const spy = spyThen && priceCache.SPY ? ((priceCache.SPY - spyThen) / spyThen) * 100 : null;
      rows.push({ id: d.id, date: d.created_at.slice(0, 10), sym, action, then, now, chg, correct, spy });
    }
  }

  const recentNote = skipped ? `\n${skipped} karar son 5 gunde verildigi icin henuz degerlendirilmedi.` : '';
  if (!rows.length) return 'Karne: degerlendirilebilecek karar yok.' + recentNote;

  const lines = rows.map(r =>
    `${r.correct ? '✅' : '❌'} #${r.id} ${r.date} ${r.action} ${r.sym}: $${r.then.toFixed(2)} → $${r.now.toFixed(2)} (${r.chg >= 0 ? '+' : ''}${r.chg.toFixed(1)}%` +
    (r.spy != null ? ` | piyasa ${r.spy >= 0 ? '+' : ''}${r.spy.toFixed(1)}%)` : ')')
  );
  const ok = rows.filter(r => r.correct).length;
  const byAction = ['AL', 'SAT', 'TUT', 'BEKLE'].map(a => {
    const g = rows.filter(r => r.action === a);
    return g.length ? `${a}: ${g.filter(r => r.correct).length}/${g.length}` : null;
  }).filter(Boolean).join(' | ');

  return '📋 KOMITE KARNESI\n' +
    'Kural: AL/TUT sonrasi fiyat yukseldiyse, SAT/BEKLE sonrasi dustuyse dogru.\n' +
    '"piyasa" = ayni donemde S&P 500 (SPY) degisimi.\n\n' +
    lines.join('\n') +
    `\n\nTOPLAM: ${ok}/${rows.length} dogru (%${Math.round(ok / rows.length * 100)})\n${byAction}${recentNote}` +
    '\n\nNot: Kisa surede (birkac hafta) sonuclar sansa cok bagli; uzun vadeli yatirimda anlamli olmasi icin aylar gerekir.';
}

module.exports = { buildScorecard };
