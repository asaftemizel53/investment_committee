// services/healthCheck.js — VERI KAYNAGI SAGLIK KONTROLU
// Amac: bir veri kaynagi (Yahoo, NewsAPI...) sessizce bos donmeye baslarsa
// bunu FARK ETMEK. Her sabah toplantidan once otomatik calisir ve sunucu
// acilisinda bir kez calisir; sorun varsa Telegram'a uyari gonderir.
// Telegram'dan /saglik yazarak istedigin an elle de calistirabilirsin.

const { fetchQuote } = require('./marketData');
const { getMacroData } = require('./macroData');
const { getFundamentalData } = require('./fundamentalData');
const { getTechnicalData } = require('./technicalIndicators');
const { getNewsForSymbol } = require('./newsData');
const { sendTelegramMessage } = require('./telegram');

async function checkDataSources({ notifyOnSuccess = false } = {}) {
  const results = [];

  const q = await fetchQuote('AAPL');
  results.push({ name: 'Canli fiyat (Yahoo v8)', ok: !!(q && q.price) });

  const macro = await getMacroData();
  results.push({ name: 'Makro veri — Claude (VIX/tahvil/DXY)', ok: !!macro });

  const tech = await getTechnicalData('AAPL');
  results.push({ name: 'Teknik gostergeler — GPT (RSI/MACD)', ok: !!tech });

  const fund = await getFundamentalData('AAPL');
  results.push({ name: 'Temel veri — Gemini (bilanco)', ok: !!fund });

  if (process.env.NEWS_API_KEY) {
    const news = await getNewsForSymbol('AAPL');
    results.push({ name: 'Haberler (NewsAPI)', ok: !!news });
  } else {
    results.push({ name: 'Haberler (NewsAPI)', ok: false, note: 'NEWS_API_KEY tanimsiz' });
  }

  const dead = results.filter(r => !r.ok);
  if (dead.length) {
    await sendTelegramMessage(
      '⚠️ VERI KAYNAGI UYARISI\n\nSu kaynaklar bos donuyor:\n' +
      dead.map(d => '• ' + d.name + (d.note ? ' (' + d.note + ')' : '')).join('\n') +
      '\n\nCalisan kaynaklar:\n' +
      (results.filter(r => r.ok).map(r => '• ' + r.name).join('\n') || '(hicbiri!)') +
      '\n\nAgentlar eksik veriyle toplanti yapacak. Kaynak API degismis olabilir — bu uyariyi Claude\'a gonderip guncel cozum isteyebilirsin.'
    );
  } else if (notifyOnSuccess) {
    await sendTelegramMessage(
      '✅ Veri kaynagi kontrolu: tum kaynaklar calisiyor.\n' +
      results.map(r => '• ' + r.name).join('\n')
    );
  }

  console.log('[SAGLIK]', results.map(r => (r.ok ? 'OK ' : 'HATA ') + r.name).join(' | '));
  return results;
}

module.exports = { checkDataSources };
