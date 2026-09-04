// routes/midas.js — Arayuz icin gercek Midas portfoyu ve karar gecmisi.
//   GET /api/midas     -> pozisyonlar (canli fiyat + K/Z ile) ve izleme listesi
//   GET /api/decisions -> tum komite kararlari (+/- durumlariyla, yeniden eskiye)

const express = require('express');
const router = express.Router();
const { getPositions, getWatchlist, getAllDecisions } = require('../services/storage');
const { fetchQuote } = require('../services/marketData');

router.get('/midas', async (req, res) => {
  const positions = getPositions();
  const watchlist = getWatchlist();
  const symbols = [...new Set([...positions.map(p => p.symbol), ...watchlist])];
  const quotes = await Promise.all(symbols.map(s => fetchQuote(s)));
  const priceMap = {};
  quotes.filter(Boolean).forEach(q => { priceMap[q.symbol] = q.price; });

  res.json({
    positions: positions.map(p => {
      const cur = priceMap[p.symbol] || null;
      return {
        symbol: p.symbol,
        qty: p.qty,
        avgCost: p.avg_cost,
        currentPrice: cur,
        cost: p.qty * p.avg_cost,
        value: cur ? p.qty * cur : null,
        pnl: cur ? (p.qty * cur) - (p.qty * p.avg_cost) : null
      };
    }),
    watchlist: watchlist.map(s => ({ symbol: s, price: priceMap[s] || null }))
  });
});

router.get('/decisions', (req, res) => {
  res.json(getAllDecisions());
});

module.exports = router;
