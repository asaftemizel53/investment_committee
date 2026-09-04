function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'];

  if (!key) {
    return res.status(401).json({
      ok: false,
      error: 'Yetkisiz istek: x-api-key header eksik.'
    });
  }

  if (key !== process.env.INTERNAL_KEY) {
    return res.status(403).json({
      ok: false,
      error: 'Gecersiz API anahtari.'
    });
  }

  next();
}

module.exports = { requireAuth };
