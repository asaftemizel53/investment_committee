// routes/trade.js — ALPACA EMIR HATASI DUZELTILDI.
// Eski kod: notional (dolar) + bracket + gtc birlikte gonderiyordu.
// Alpaca kurallari: bracket emir icin qty (adet) gerekir, notional ile
// bracket desteklenmez; kesirli hisse emirleri 'day' olmak zorundadir.
// Yeni mantik:
//   1) Guncel fiyati cek, qty = amount / fiyat hesapla.
//   2) qty >= 1 tam hisse ise: tam adetli BRACKET emir (stop + hedef dahil, gtc).
//   3) qty < 1 (kesirli) ise: notional MARKET emir (day) gonder; stop/hedef
//      bracket olarak eklenemedigi icin Telegram'da acikca belirtilir.

const express = require('express');
const router = express.Router();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const { requireAuth } = require('../middleware/auth');
const { tradeLimiter } = require('../middleware/tradeLimiter');
const { parseTradeJson } = require('../middleware/parseTradeJson');
const { callClaude } = require('../agents/claude');
const { loadPortfolio, loadTriggers, saveTriggers, loadMemory, saveMemory } = require('../services/storage');
const { sendTelegramMessage } = require('../services/telegram');
const { fetchQuote } = require('../services/marketData');

const alpaca = new Alpaca({ keyId: process.env.ALPACA_API_KEY, secretKey: process.env.ALPACA_SECRET_KEY, paper: true });

router.post('/consensus', requireAuth, async (req, res) => {
  const { votes, topic, portfolioId } = req.body;
  const portfolio = loadPortfolio(portfolioId || 'midas');
  const system = 'Sen simule edilmis bir yatirim komitesinin baskanisın. Gorevin analistlerin oylarini ozetleyip komite gorusu cikarmak; emir vermek degil. Nihai karar kullaniciya aittir.\nKURAL: Sadece JSON formatinda yanit ver. Markdown kullanma.';
  const prompt = 'Portfoy: ' + portfolio.name + '\n\nOylar:\n' + votes.map(v => v.name + ': ' + v.text).join('\n\n') + '\n\nKonu: ' + topic + '\n\nJSON formatinda yanit ver:\n{"action":"AL veya SAT veya BEKLE","symbol":"AAPL gibi","amount":100,"stopLoss":170.00,"takeProfit":200.00,"rationale":"gerekce","trigger":{"symbol":"VIX veya null","operator":"operator veya null","target":20}}';
  try {
    const raw = await callClaude([{ role: 'user', content: prompt }], system);
    const parsed = parseTradeJson(raw);
    if (!parsed.ok) {
      console.error('Parse hatasi:', parsed.error);
      return res.json({ text: raw, structuredData: null, parseError: parsed.error });
    }
    const d = parsed.data;
    const lines = [
      'KONSENSUS: ' + d.action,
      'SEMBOL: ' + d.symbol,
      'MIKTAR: $' + d.amount,
      d.stopLoss ? 'STOP-LOSS: $' + d.stopLoss : null,
      d.takeProfit ? 'HEDEF: $' + d.takeProfit : null,
      'GEREKCE: ' + d.rationale,
      d.trigger?.symbol ? 'TETIKLEYICI: ' + d.trigger.symbol + ' ' + d.trigger.operator + ' ' + d.trigger.target : 'TETIKLEYICI: N/A'
    ].filter(Boolean);
    if (d.trigger?.symbol) {
      const triggers = loadTriggers();
      triggers.push({ id: Date.now(), topic, symbol: d.trigger.symbol.toUpperCase(), operator: d.trigger.operator, target: d.trigger.target, status: 'active' });
      saveTriggers(triggers); // storage katmani ayni tetikleyiciyi iki kez kaydetmez
    }
    res.json({ text: lines.join('\n'), structuredData: d });
  } catch (e) { res.json({ text: 'Hata: ' + e.message, structuredData: null }); }
});

router.post('/execute-trade', requireAuth, tradeLimiter, async (req, res) => {
  let d = req.body.structuredData;
  if (!d && req.body.consensusText) {
    const p = parseTradeJson(req.body.consensusText);
    if (!p.ok) return res.json({ ok: false, error: 'Emir okunamadi: ' + p.error });
    d = p.data;
  }
  if (!d) return res.json({ ok: false, error: 'structuredData eksik.' });
  if (d.action === 'BEKLE' || d.action === 'TUT') {
    return res.json({ ok: false, error: 'Karar ' + d.action + ', emir iletilmedi.' });
  }
  try {
    const quote = await fetchQuote(d.symbol);
    if (!quote?.price) return res.json({ ok: false, error: d.symbol + ' icin guncel fiyat alinamadi, emir iletilmedi.' });

    const side = ['AL', 'KADEMELI AL'].includes(d.action) ? 'buy' : 'sell';
    const wholeQty = Math.floor(d.amount / quote.price);
    let order, orderDesc;

    if (wholeQty >= 1) {
      // Tam hisse: bracket destekleniyor (qty ile)
      const params = {
        symbol: d.symbol, qty: wholeQty, side,
        type: 'market', time_in_force: 'gtc'
      };
      if (d.stopLoss && d.takeProfit) {
        params.order_class = 'bracket';
        params.stop_loss = { stop_price: d.stopLoss };
        params.take_profit = { limit_price: d.takeProfit };
      } else if (d.stopLoss) {
        params.order_class = 'oto';
        params.stop_loss = { stop_price: d.stopLoss };
      }
      order = await alpaca.createOrder(params);
      orderDesc = wholeQty + ' adet ' + d.symbol + ' (~$' + (wholeQty * quote.price).toFixed(2) + ') ' + d.action +
        (params.order_class ? ' | Stop: $' + (d.stopLoss || '-') + ' Hedef: $' + (d.takeProfit || '-') : '');
    } else {
      // Kesirli hisse: bracket YOK, sadece notional market + day
      order = await alpaca.createOrder({
        symbol: d.symbol, notional: d.amount, side,
        type: 'market', time_in_force: 'day'
      });
      orderDesc = '$' + d.amount + ' ' + d.symbol + ' ' + d.action + ' (kesirli hisse — stop/hedef otomatik EKLENEMEDI, elle takip et: Stop $' + (d.stopLoss || '-') + ' / Hedef $' + (d.takeProfit || '-') + ')';
    }

    const mem = loadMemory();
    if (mem.length) { mem[mem.length - 1].applied = true; saveMemory(mem); }
    await sendTelegramMessage('ALPACA (paper): ' + orderDesc);
    res.json({ ok: true, message: orderDesc, orderId: order.id });
  } catch (e) { res.json({ ok: false, error: 'Alpaca Hatasi: ' + e.message }); }
});

module.exports = router;
