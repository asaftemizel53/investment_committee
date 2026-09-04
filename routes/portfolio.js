const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { loadPortfolio, savePortfolio } = require('../services/storage');

router.get('/portfolio/:id', (req, res) => res.json(loadPortfolio(req.params.id)));
router.post('/portfolio/:id', requireAuth, (req, res) => {
  savePortfolio(req.params.id, req.body);
  res.json({ ok: true });
});

module.exports = router;
