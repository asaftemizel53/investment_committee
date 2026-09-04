// routes/memory.js — Kayit oncesi hata filtresi eklendi (appendMemory).
// API yaniti iceren "toplanti" kayitlari (quota, fetch failed vb.)
// artik hafizaya yazilmiyor.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { loadMemory, appendMemory } = require('../services/storage');

const TODAY = () => new Date().toLocaleDateString('tr-TR',
  { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

router.get('/memory', (req, res) => res.json(loadMemory()));

router.post('/save-meeting', requireAuth, (req, res) => {
  const saved = appendMemory({ ...req.body, date: TODAY() });
  res.json({ ok: true, saved, note: saved ? undefined : 'Hata iceren kayit filtrelendi.' });
});

module.exports = router;
