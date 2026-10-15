// services/marketData.js — v7/quote endpoint'i artik auth istedigi icin
// v8/chart endpoint'ine gecildi (sembol basina bir istek, paralel).

// Modellerin/kullanicinin yazdigi yaygin adlar -> Yahoo sembolu
const SYMBOL_ALIASES = {
  VIX: '^VIX', US10Y: '^TNX', TNX: '^TNX', '10Y': '^TNX', DXY: 'DX-Y.NYB',
  SPX: '^GSPC', SP500: '^GSPC', NDX: '^NDX', IXIC: '^IXIC', GOLD: 'GC=F', OIL: 'CL=F'
};
function normalizeSymbol(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  return SYMBOL_ALIASES[s] || s;
}

async function fetchQuote(symbol) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizeSymbol(symbol))}?interval=1d&range=5d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = await r.json();
    const meta = d.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    return {
      symbol,
      price: meta.regularMarketPrice,
      prevClose: meta.chartPreviousClose || meta.previousClose || null,
      high52: meta.fiftyTwoWeekHigh || null,
      low52: meta.fiftyTwoWeekLow || null
    };
  } catch (e) { return null; }
}

function formatQuote(q) {
  const chg = q.prevClose ? (((q.price - q.prevClose) / q.prevClose) * 100).toFixed(2) + '%' : 'N/A';
  const range = (q.high52 && q.low52) ? ` (52H: $${q.high52}/$${q.low52})` : '';
  return `► ${q.symbol}: $${q.price} | Gunluk: ${chg}${range}`;
}

// Eski imza korunuyor: konusma gecmisinden sembol yakala, canli veri getir
async function getDynamicTickerData(history) {
  if (!history || !history.length) return '';
  const ignore = ['AL','SAT','BEKLE','FED','ABD','ETF','RSI','MACD','CEO','KARAR','SEMBOL','N/A','YKS','TUM','PEG','NOT','PZT'];
  const text = history.slice(-3).map(h => h.text).join(' ');
  const matches = [...new Set((text.match(/\b[A-Z\^]{2,5}\b/g) || []))]
    .filter(m => !ignore.includes(m)).slice(0, 3);
  if (!matches.length) return '';
  const quotes = (await Promise.all(matches.map(fetchQuote))).filter(Boolean);
  if (!quotes.length) return '';
  return '\n\n[CANLI BORSA]\n' + quotes.map(formatQuote).join('\n');
}

// Yeni: sabah toplantisi icin sembol listesine toplu veri
async function getQuotesFor(symbols) {
  const uniq = [...new Set(symbols.map(s => s.toUpperCase()))].slice(0, 15);
  const quotes = (await Promise.all(uniq.map(fetchQuote))).filter(Boolean);
  return quotes;
}

// Serbest metindeki sirketleri borsa sembolune cevirir ("rocketlab,spacex" ->
// RKLB, SPCX). Modellerin egitim bilgisi eski oldugu icin (sonradan halka arz
// olan sirketleri "halka acik degil" sanabilirler) gundemdeki her sirketin
// canli verisi baglama acikca eklenmeli.
// 1) Kucuk bir LLM cagrisi metinden sirket adlarini cikarir (yazim/buyuk-kucuk
//    harf/Turkce ek fark etmez; kelime tahmini guvenilmezdi: "dusus" -> Dominion).
// 2) Sembol Yahoo aramasiyla dogrulanir (LLM'in bildigi sembol eski olabilir).
async function yahooSearch(query) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = await r.json();
    return (d.quotes || []).filter(q => ['EQUITY', 'ETF'].includes(q.quoteType) && q.symbol);
  } catch (e) { return []; }
}

async function extractCompanies(text) {
  const { callClaude } = require('../agents/claude'); // gec yukleme: dongusel bagimlilik olmasin
  const system = 'Gorevin: verilen metinde adi gecen SIRKETLERI, hisseleri ve ETFleri bulmak. ' +
    'Yazim hatalarini, kucuk harfle ya da bitisik yazilmis adlari (orn. "rocketlab", "spacex") ve Turkce ekleri tani. ' +
    'Endeksleri, makro gostergeleri (VIX, US10Y, tahvil, Fed, DXY, enflasyon) ve genel kelimeleri ALMA. ' +
    'Yanitin SADECE JSON dizisi olsun, markdown yok: [{"name":"Rocket Lab","ticker":"RKLB"}]. ' +
    'Sembolu bilmiyorsan ticker null olsun. Hic sirket yoksa [] don.';
  const raw = await callClaude([{ role: 'user', content: text.slice(0, 2000) }], system);
  try {
    const arr = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
    return Array.isArray(arr) ? arr.filter(c => c && (c.name || c.ticker)).slice(0, 8) : null;
  } catch (e) {
    console.error('[SEMBOL] Sirket cikarimi okunamadi:', String(raw).slice(0, 150));
    return null;
  }
}

async function resolveCompany(c) {
  const name = String(c.name || '').trim();
  const ticker = String(c.ticker || '').trim().toUpperCase();
  // Once ada gore ara (guncel sembol), bulunamazsa LLM'in verdigi sembolu dene
  const byName = name ? await yahooSearch(name) : [];
  let hit = byName.find(q => q.symbol.toUpperCase() === ticker) || byName[0];
  if (!hit && ticker) hit = (await yahooSearch(ticker)).find(q => q.symbol.toUpperCase() === ticker);
  if (!hit) return null;
  return { term: name || ticker, symbol: hit.symbol, name: hit.longname || hit.shortname || hit.symbol, exchange: hit.exchDisp || '' };
}

const resolveCache = new Map(); // ayni metin icin tekrar LLM cagrisi yapma (web panelinde her tur)
async function resolveSymbols(text) {
  if (!text || !text.trim()) return [];
  if (resolveCache.has(text)) return resolveCache.get(text);
  const companies = await extractCompanies(text);
  if (!companies) return []; // cikarim basarisizsa bos don, cache'leme (sonra tekrar denensin)
  const resolved = (await Promise.all(companies.map(resolveCompany))).filter(Boolean);
  const uniq = [...new Map(resolved.map(r => [r.symbol, r])).values()];
  if (resolveCache.size > 200) resolveCache.clear();
  resolveCache.set(text, uniq);
  console.log('[SEMBOL]', uniq.map(u => u.term + '->' + u.symbol).join(', ') || '(sirket yok)');
  return uniq;
}

module.exports = { getDynamicTickerData, getQuotesFor, fetchQuote, formatQuote, resolveSymbols, normalizeSymbol };
