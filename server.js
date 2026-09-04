// server.js — Guncellenmis ana dosya (news route'lari ACIK).
// Yenilikler: node-cron ile hafta ici sabah toplantisi, iki yonlu Telegram
// dinleyici, /toplanti ile elle tetikleme, gercek /api/price endpoint'i.

const express = require('express');
const cron = require('node-cron');
require('dotenv').config();

const { startSentinel } = require('./services/sentinel');
const { startTelegramListener } = require('./services/telegram');
const { runMorningMeeting } = require('./services/meeting');
const { checkDataSources } = require('./services/healthCheck');
const { fetchQuote } = require('./services/marketData');
const agentRoutes = require('./routes/agent');
const tradeRoutes = require('./routes/trade');
const portfolioRoutes = require('./routes/portfolio');
const memoryRoutes = require('./routes/memory');
const newsRoutes = require('./routes/news');
const midasRoutes = require('./routes/midas');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use('/api', agentRoutes);
app.use('/api', tradeRoutes);
app.use('/api', portfolioRoutes);
app.use('/api', memoryRoutes);
app.use('/api', newsRoutes);
app.use('/api', midasRoutes);

app.get('/api/price/:symbol', async (req, res) => {
  const q = await fetchQuote(req.params.symbol.toUpperCase());
  res.json({ price: q?.price || 0 });
});
app.get('/api/search', async (req, res) => res.json([]));

// --- OTOMATIK TOPLANTI ZAMANLAYICI ---
// Varsayilan: HAFTALIK — her Pazartesi, ABD piyasa acilisindan 15 dk sonra
// (09:45 New York ≈ TR 16:45 yazin, 17:45 kisin). Uzun vadeli strateji icin
// gunluk toplanti gurultu uretir; ihtiyac aninda /toplanti ile toplanabilir.
// Gunluk ritme donmek icin .env: MEETING_CRON=45 9 * * 1-5
const MEETING_CRON = process.env.MEETING_CRON || '45 9 * * 1';
const MEETING_TZ = process.env.MEETING_TZ || 'America/New_York';
cron.schedule(MEETING_CRON, () => {
  runMorningMeeting().catch(e => console.error('[TOPLANTI] Hata:', e.message));
}, { timezone: MEETING_TZ });
console.log('Otomatik toplanti zamanlandi:', MEETING_CRON, '(' + MEETING_TZ + ') — haftalik, Pazartesi ABD acilisi + 15 dk');

// --- VERI KAYNAGI SAGLIK KONTROLU ---
// Sabah toplantisindan 15 dk once + sunucu acilisinda (30 sn sonra).
// Sorun varsa Telegram'a uyari duser; /saglik ile elle de calistirilir.
cron.schedule('30 9 * * 1', () => {
  checkDataSources().catch(e => console.error('[SAGLIK] Hata:', e.message));
}, { timezone: MEETING_TZ });
setTimeout(() => {
  checkDataSources().catch(e => console.error('[SAGLIK] Hata:', e.message));
}, 30000);

startSentinel();
startTelegramListener(
  (topic) => runMorningMeeting(topic).catch(e => console.error('[TOPLANTI] Hata:', e.message)),
  () => checkDataSources({ notifyOnSuccess: true }).catch(e => console.error('[SAGLIK] Hata:', e.message))
);

app.listen(process.env.PORT || 3000, () =>
  console.log('Yatirim Komitesi - http://localhost:3000'));
