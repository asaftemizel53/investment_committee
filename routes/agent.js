// routes/agent.js — Agent'a ozel veri akislari KORUNARAK guncellendi:
//   Claude (makro/risk)  -> getMacroData (VIX, tahvil, DXY...)
//   GPT (teknik)         -> getTechnicalDataForHistory (RSI, MACD, Bollinger)
//   Gemini (temel)       -> getFundamentalDataForHistory (bilanco metrikleri)
//   Hepsi                -> canli fiyat + frontend'den gelen newsContext
// Claude icin prompt caching: statik kimlik system'de (cache'li),
// dinamik veriler mesaja tasindi.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { callClaude } = require('../agents/claude');
const { callGPT } = require('../agents/gpt');
const { callGemini } = require('../agents/gemini');
const { AGENT_SYSTEMS } = require('../agents/systems');
const { loadPortfolio, getPositions } = require('../services/storage');
const { getDynamicTickerData, getQuotesFor, resolveSymbols, formatQuote } = require('../services/marketData');
const { getMacroData } = require('../services/macroData');
const { getTechnicalDataForHistory } = require('../services/technicalIndicators');
const { getFundamentalDataForHistory } = require('../services/fundamentalData');
const { getNewsForHistory } = require('../services/newsData');

router.post('/speak', requireAuth, async (req, res) => {
  const { agent, prompt, history, portfolioId, newsContext, phase } = req.body;
  const portfolio = loadPortfolio(portfolioId || 'midas');
  const positions = getPositions();

  // Ortak + agent'a ozel veri akislari (paralel cek)
  const [tickerData, agentData, newsData, quotes, promptCompanies] = await Promise.all([
    getDynamicTickerData(history),
    agent === 'claude' ? getMacroData()
      : agent === 'gpt' ? getTechnicalDataForHistory(history)
      : agent === 'gemini' ? getFundamentalDataForHistory(history)
      : Promise.resolve(''),
    getNewsForHistory(history),
    positions.length ? getQuotesFor(positions.map(p => p.symbol)) : Promise.resolve([]),
    // Soruda adi gecen sirketler ("SpaceX" -> SPCX) canli veriyle eklenir
    resolveSymbols(prompt).then(async found => {
      if (!found.length) return '';
      const qs = await getQuotesFor(found.map(f => f.symbol));
      const qm = Object.fromEntries(qs.map(q => [q.symbol, q]));
      return '\n\n[SORUDAKI SIRKETLER — CANLI BORSA VERISI]\n' + found.map(f =>
        '• ' + f.term + ' = ' + f.name + ' (' + f.symbol + ', HALKA ACIK): ' +
        (qm[f.symbol.toUpperCase()] ? formatQuote(qm[f.symbol.toUpperCase()]).replace(/^► /, '') : 'fiyat alinamadi')
      ).join('\n');
    })
  ]);

  const priceMap = Object.fromEntries(quotes.map(q => [q.symbol, q.price]));
  let positionsValue = 0;
  const positionLines = positions.map(p => {
    const price = priceMap[p.symbol];
    const curValue = price ? p.qty * price : p.qty * p.avg_cost;
    positionsValue += curValue;
    return `  • ${p.symbol}: ${p.qty} adet @ maliyet $${p.avg_cost}` +
      (price ? `, guncel $${price.toFixed(2)}, deger $${curValue.toFixed(2)}` : ' (guncel fiyat alinamadi, maliyetle hesaplandi)');
  });
  const totalValue = portfolio.cash + positionsValue;
  const maxPerPosition = totalValue * 0.25;
  const pfCtx = '[PORTFOY: ' + portfolio.name + ']\n' +
    '- Nakit: $' + portfolio.cash.toFixed(2) + '\n' +
    '- Toplam Deger (nakit + pozisyonlar): $' + totalValue.toFixed(2) + '\n' +
    '- Pozisyon Basina Maksimum (%25): $' + maxPerPosition.toFixed(2) + '\n' +
    '- Mevcut Pozisyonlar:\n' +
    (positionLines.length ? positionLines.join('\n') : '  (pozisyon yok)');

  const staticSystem = AGENT_SYSTEMS[agent](portfolio.strategy, phase);
  const dynamicContext = [
    pfCtx,
    promptCompanies,
    tickerData,
    agentData,
    newsData,
    newsContext ? '\n\n[GUNDEM HABER OZETI]\n' + newsContext : ''
  ].filter(Boolean).join('');

  const fullPrompt = prompt + (history?.length
    ? '\n\n[GECMIS]\n' + history.slice(-15).map(h => h.name + ': ' + h.text).join('\n') : '');

  try {
    let text;
    if (agent === 'claude') {
      text = await callClaude([{ role: 'user', content: fullPrompt }], staticSystem, dynamicContext);
    } else if (agent === 'gpt') {
      text = await callGPT([{ role: 'user', content: fullPrompt }], staticSystem + '\n\n' + dynamicContext);
    } else if (agent === 'gemini') {
      text = await callGemini(fullPrompt, staticSystem + '\n\n' + dynamicContext);
    }
    res.json({ text, agent, name: agent.toUpperCase(), role: '' });
  } catch (e) { res.json({ text: 'Hata: ' + e.message }); }
});

module.exports = router;
