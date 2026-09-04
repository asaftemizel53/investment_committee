const rateLimit = require('express-rate-limit');

const tradeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: {
    ok: false,
    error: 'Cok fazla emir istegi. 1 dakika bekleyin.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { tradeLimiter };
