// services/sentinel.js — Nobetci sistemi.
// Iyilestirme: ABD piyasasi kapaliyken (hafta sonu + gece) Yahoo'ya
// gereksiz istek atmiyor. Fiyat kontrolu piyasa saatlerinde her 60 sn.

const { loadTriggers, saveTriggers } = require('./storage');
const { sendTelegramMessage } = require('./telegram');
const { fetchQuote } = require('./marketData');

function isUsMarketLikelyOpen() {
  // ET saatine gore Pzt-Cum 09:30-16:00 (pre/post market dahil degil).
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0 Pazar, 6 Cumartesi
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function startSentinel() {
  setInterval(async () => {
    if (!isUsMarketLikelyOpen()) return;
    const triggers = loadTriggers();
    let updated = false;
    for (const t of triggers) {
      if (t.status !== 'active') continue;
      const q = await fetchQuote(t.symbol);
      if (!q?.price) continue;
      const op = String(t.operator || '').trim();
      const target = Number(t.target);
      const hit = (['>', '>='].includes(op) && q.price >= target) ||
                  (['<', '<='].includes(op) && q.price <= target);
      if (hit) {
        const msg = '🚨 YATIRIM KOMITESI UYARISI\n' + t.symbol + ' = $' + q.price +
          ' (Sart: ' + t.operator + ' ' + t.target + ')\nKonu: ' + (t.topic || '-') +
          '\n\n/toplanti yazarak acil toplanti baslatabilirsin.';
        console.log('\n[NOBETCI]', msg.replace(/\n/g, ' '), '\n');
        await sendTelegramMessage(msg);
        t.status = 'triggered';
        updated = true;
      }
    }
    if (updated) saveTriggers(triggers);
  }, 60000);
  console.log('Nobetci sistemi aktif (sadece piyasa saatlerinde kontrol)');
}

module.exports = { startSentinel };
