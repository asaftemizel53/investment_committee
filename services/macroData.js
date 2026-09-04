// services/macroData.js — DUZELTILDI: v7/quote endpoint'i auth istedigi icin
// sessizce bos donuyordu; v8/chart'a gecildi (sembol basina paralel istek).
// Claude'un (Makro & Risk) VIX/tahvil/DXY veri akisi artik gercekten calisiyor.

const MACRO_SYMBOLS = [
  { symbol: '^VIX',     label: 'VIX (Korku Endeksi)' },
  { symbol: '^TNX',     label: '10Y ABD Tahvil Faizi (%)' },
  { symbol: 'DX-Y.NYB', label: 'DXY (Dolar Endeksi)' },
  { symbol: '^GSPC',    label: 'S&P 500' },
  { symbol: '^IXIC',    label: 'NASDAQ' },
  { symbol: 'GC=F',     label: 'Altin ($/oz)' },
  { symbol: 'CL=F',     label: 'Ham Petrol ($/varil)' }
];

async function fetchMeta(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(symbol) + '?interval=1d&range=5d';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    const meta = d.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice === undefined) return null;
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    return { symbol, price: meta.regularMarketPrice, prev };
  } catch (e) { return null; }
}

async function getMacroData() {
  try {
    const results = (await Promise.all(MACRO_SYMBOLS.map(m => fetchMeta(m.symbol)))).filter(Boolean);
    if (!results.length) return '';

    const lines = results.map(q => {
      const meta = MACRO_SYMBOLS.find(m => m.symbol === q.symbol);
      const label = meta ? meta.label : q.symbol;
      const price = q.price.toFixed(2);
      const change = (q.prev && q.prev !== 0)
        ? (() => { const c = ((q.price - q.prev) / q.prev) * 100; return (c >= 0 ? '+' : '') + c.toFixed(2) + '%'; })()
        : '';

      let comment = '';
      if (q.symbol === '^VIX') {
        if (q.price >= 30) comment = '(YUKSEK - Piyasa panikte)';
        else if (q.price >= 20) comment = '(ORTA - Tedirginlik var)';
        else comment = '(DUSUK - Piyasa sakin)';
      }
      if (q.symbol === '^TNX') {
        if (q.price >= 5) comment = '(COK YUKSEK - Hisse baskisi)';
        else if (q.price >= 4) comment = '(YUKSEK - Dikkatli ol)';
        else comment = '(NORMAL seviye)';
      }

      return label + ': ' + price + ' ' + change + ' ' + comment;
    });

    return '\n\n[MAKRO EKONOMI VERILERI]\n' + lines.join('\n');
  } catch (e) {
    console.error('Makro veri hatasi:', e.message);
    return '';
  }
}

module.exports = { getMacroData };
