const express = require('express');
const router = express.Router();
const { getNewsForTopic } = require('../services/newsData');

router.get('/news', async (req, res) => {
  const topic = req.query.q || 'stock market';
  const result = await getNewsForTopic(topic);
  res.json(result);
});

module.exports = router;
