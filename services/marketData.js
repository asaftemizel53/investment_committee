// services/marketData.js — v7/quote endpoint'i artik auth istedigi icin
// v8/chart endpoint'ine gecildi (sembol basina bir istek, paralel).

async function fetchQuote(symbol) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`,
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

module.exports = { getDynamicTickerData, getQuotesFor, fetchQuote, formatQuote };
