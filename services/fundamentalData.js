// services/fundamentalData.js — quoteSummary endpoint'i artik cookie + crumb
// dogrulamasi istiyor; eski kod bu yuzden buyuk ihtimalle sessizce null
// donuyordu. Cookie/crumb bir kez alinip 30 dk cache'lenir. Alinamazsa
// eski davranisla ayni: sessizce null (agent temel veri olmadan devam eder).

let yAuth = null; // { cookie, crumb, ts }

async function getYahooAuth() {
  if (yAuth && Date.now() - yAuth.ts < 30 * 60 * 1000) return yAuth;
  try {
    const r1 = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual'
    });
    const setCookie = r1.headers.get('set-cookie');
    if (!setCookie) return null;
    const cookie = setCookie.split(';')[0];
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie }
    });
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.length > 30 || crumb.includes('<')) return null;
    yAuth = { cookie, crumb, ts: Date.now() };
    return yAuth;
  } catch (e) { return null; }
}

async function getFundamentalData(symbol) {
  try {
    const auth = await getYahooAuth();
    if (!auth) return null;
    const modules = 'financialData,defaultKeyStatistics,summaryDetail,earningsTrend';
    const url = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + symbol +
      '?modules=' + modules + '&crumb=' + encodeURIComponent(auth.crumb);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': auth.cookie }
    });
    const d = await r.json();
    const result = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
    if (!result) return null;

    const fd = result.financialData || {};
    const ks = result.defaultKeyStatistics || {};
    const sd = result.summaryDetail || {};

    function fmt(v, suffix) {
      if (v === null || v === undefined) return 'N/A';
      const val = v.raw !== undefined ? v.raw : v;
      if (val === null || val === undefined || isNaN(val)) return 'N/A';
      if (suffix === '%') return (val * 100).toFixed(1) + '%';
      if (suffix === 'B') return '$' + (val / 1e9).toFixed(2) + 'B';
      if (suffix === 'x') return val.toFixed(2) + 'x';
      return val.toFixed(2);
    }

    const lines = [
      '--- TEMEL ANALIZ: ' + symbol + ' ---',
      'Gelir Buyumesi: ' + fmt(fd.revenueGrowth, '%') + ' | Toplam Gelir: ' + fmt(fd.totalRevenue, 'B'),
      'Brut Marj: ' + fmt(fd.grossMargins, '%') + ' | Faaliyet Marji: ' + fmt(fd.operatingMargins, '%') + ' | Net Marj: ' + fmt(fd.profitMargins, '%'),
      'Ozkaynak Karliligi (ROE): ' + fmt(fd.returnOnEquity, '%'),
      'Borc/Ozkaynak: ' + fmt(fd.debtToEquity, 'x') + ' | Cari Oran: ' + fmt(fd.currentRatio, 'x'),
      'EPS: ' + fmt(ks.trailingEps, '') + ' | PEG: ' + fmt(ks.pegRatio, 'x') + ' | Beta: ' + fmt(ks.beta, ''),
      'Aciga Satis Orani: ' + fmt(ks.shortRatio, 'x') + ' | Temettü: ' + fmt(sd.dividendYield, '%') + ' | Dagitim Orani: ' + fmt(sd.payoutRatio, '%')
    ];

    return lines.join('\n');
  } catch (e) {
    console.error('Temel veri hatasi (' + symbol + '):', e.message);
    return null;
  }
}

async function getFundamentalDataForHistory(history) {
  if (!history || !history.length) return '';
  const ignore = ['AL', 'SAT', 'BEKLE', 'FED', 'ABD', 'ETF', 'RSI', 'MACD', 'CEO', 'KARAR', 'SEMBOL', 'N/A'];
  const text = history.slice(-3).map(h => h.text).join(' ');
  const found = text.match(/\b[A-Z]{2,5}\b/g) || [];
  const symbols = [...new Set(found)].filter(m => !ignore.includes(m)).slice(0, 2);
  if (!symbols.length) return '';
  const results = await Promise.all(symbols.map(s => getFundamentalData(s)));
  const valid = results.filter(Boolean);
  if (!valid.length) return '';
  return '\n\n[TEMEL FINANSAL VERILER]\n' + valid.join('\n\n');
}

module.exports = { getFundamentalDataForHistory, getFundamentalData };
