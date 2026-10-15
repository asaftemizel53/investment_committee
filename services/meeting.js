// services/meeting.js — SABAH TOPLANTISI (otomatik, sunucu tarafinda)
// Akis: pozisyonlar + izleme listesi -> canli veri -> 3 analist oyu ->
// baskan (Claude) JSON konsensus -> decisions tablosuna 'pending' kayit ->
// Telegram bildirimi. Kullanici + / - ile geri bildirim verir.
// NOT: Bu toplanti HICBIR emir gondermez; Midas'ta uygulama tamamen kullanicida.

const { callClaude } = require('../agents/claude');
const { callGPT } = require('../agents/gpt');
const { callGemini } = require('../agents/gemini');
const { AGENT_SYSTEMS } = require('../agents/systems');
const { getPositions, getWatchlist, addDecision, appendMemory, loadMemory, getNotes, getAllDecisions } = require('./storage');
const { getQuotesFor, formatQuote, resolveSymbols } = require('./marketData');
const { getMacroData } = require('./macroData');
const { getTechnicalData } = require('./technicalIndicators');
const { getFundamentalData } = require('./fundamentalData');
const { sendTelegramMessage } = require('./telegram');
const { parseTradeJson } = require('../middleware/parseTradeJson');
const { getNewsForTopic } = require('./newsData');

const MIDAS_STRATEGY = 'Gercek Midas portfoyu. Amac: mevcut pozisyonlari korumak/degerlendirmek ve izleme listesindeki firsatlari takip etmek. Kullanici islemleri Midas uzerinden elle yapar.';

function todayTR() {
  return new Date().toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// Model hata metnini (API hatasi, baglanti hatasi, bos yanit) gecerli oydan ayir
function isAgentError(text) {
  const t = String(text || '');
  return /^Hata \((Claude|GPT|Gemini)\)/.test(t) || /baglanti hatasi/i.test(t) || t === 'Bos Yanit';
}

// Ayni anda iki toplanti calismasin (cift /toplanti, cron + elle tetikleme)
let meetingRunning = false;

async function runMorningMeeting(customTopic) {
  if (meetingRunning) {
    await sendTelegramMessage('Zaten devam eden bir toplanti var, bitmesini bekle.');
    return;
  }
  meetingRunning = true;
  try {
    await runMeetingInner(customTopic);
  } finally {
    meetingRunning = false;
  }
}

async function runMeetingInner(customTopic) {
  console.log('[TOPLANTI] Toplanti basliyor...' + (customTopic ? ' Gundem: ' + customTopic : ''));
  const positions = getPositions();
  const watchlist = getWatchlist();

  if (!positions.length && !watchlist.length) {
    await sendTelegramMessage('Sabah toplantisi atlandi: portfoy ve izleme listesi bos.\n/portfoy ve /izle komutlariyla ekleme yap.');
    return;
  }

  // 1) Canli veri: fiyatlar + makro ortam + pozisyonlarin teknik gostergeleri
  // Gundemde adi gecen sirketler (orn. "SpaceX" -> SPCX) canli veriyle eklenir;
  // aksi halde modeller eski egitim bilgisine doner.
  const topicSymbols = customTopic ? await resolveSymbols(customTopic) : [];
  const symbols = [...topicSymbols.map(t => t.symbol), ...positions.map(p => p.symbol), ...watchlist];
  const techSymbols = [...new Set(symbols.map(s => s.toUpperCase()))]; // her sembol icin teknik + temel veri
  const newsQuery = customTopic || 'stock market economy Fed';
  const [quotes, macroData, techResults, fundResults, topicNews] = await Promise.all([
    getQuotesFor(symbols),
    getMacroData(),
    Promise.all(techSymbols.map(s => getTechnicalData(s))),
    // Temel analist (Gemini) bilanco verisi olmadan eski bilgisine donmesin
    Promise.all(techSymbols.map(s => getFundamentalData(s))),
    getNewsForTopic(newsQuery).catch(() => ({ articles: [] }))
  ]);
  const quoteMap = Object.fromEntries(quotes.map(q => [q.symbol, q]));
  const techText = techResults.filter(Boolean).join('\n\n');
  const fundText = fundResults.filter(Boolean).join('\n\n');

  const posText = positions.length
    ? positions.map(p => {
        const q = quoteMap[p.symbol];
        const cur = q ? q.price : null;
        const pnl = cur ? (((cur - p.avg_cost) / p.avg_cost) * 100).toFixed(2) + '%' : 'N/A';
        return `• ${p.symbol}: ${p.qty} adet @ $${p.avg_cost} | Guncel: ${cur ? '$' + cur : 'N/A'} | K/Z: ${pnl}`;
      }).join('\n')
    : '(pozisyon yok)';
  const watchText = watchlist.length
    ? watchlist.map(s => quoteMap[s] ? formatQuote(quoteMap[s]) : '► ' + s + ': veri yok').join('\n')
    : '(izleme listesi bos)';

  const topicText = topicSymbols.length
    ? '\n\n[GUNDEMDEKI SIRKETLER — CANLI BORSA VERISI]\n' + topicSymbols.map(t => {
        const q = quoteMap[t.symbol.toUpperCase()];
        return '• ' + t.term + ' = ' + t.name + ' (' + t.symbol + (t.exchange ? ', ' + t.exchange : '') + ', HALKA ACIK): ' +
          (q ? formatQuote(q).replace(/^► /, '') : 'fiyat alinamadi');
      }).join('\n')
    : '';

  // Kalici notlar (/not) — kullanicinin stratejik hatirlatmalari, HER toplantida verilir
  const notes = getNotes();
  const notesText = notes.length
    ? '\n\n[KALICI STRATEJI NOTLARI — KULLANICIDAN]\n' + notes.map(n => '• ' + n.text).join('\n')
    : '';

  // Gecmis toplantilarin ozeti — agent'lar cagrilar arasinda hicbir sey hatirlamaz,
  // bu yuzden son toplantilar her seferinde geri beslenir
  const recentMem = loadMemory().slice(-10);
  const memText = recentMem.length
    ? '\n\n[GECMIS TOPLANTILAR — SON ' + recentMem.length + ' OZET]\n' +
      recentMem.map(m => '• ' + (m.date || '') + ' | ' + (m.topic || '') + ': ' + String(m.karar || '')).join('\n')
    : '';

  // Son kararlar + kullanicinin +/- geri bildirimi
  const stMap = { applied: 'UYGULANDI', rejected: 'REDDEDILDI', pending: 'BEKLIYOR' };
  const recentDecs = getAllDecisions().slice(0, 20);
  const decText = recentDecs.length
    ? '\n\n[SON KOMITE KARARLARI VE KULLANICI GERI BILDIRIMI]\n' +
      recentDecs.map(d => '• #' + d.id + ' ' + d.action + ' ' + d.symbol + ' -> ' + (stMap[d.status] || d.status)).join('\n')
    : '';

  // Guncel haber basliklari
  const newsText = (topicNews.articles || []).length
    ? '\n\n[GUNCEL HABER BASLIKLARI: ' + newsQuery + ']\n' +
      topicNews.articles.map(a => '• [' + (a.date || '') + '] ' + a.title + ' (' + (a.source || '') + ')').join('\n')
    : '';

  const context = `[TARIH] ${todayTR()}\n\n[MEVCUT PORTFOY - MIDAS]\n${posText}\n\n[IZLEME LISTESI]\n${watchText}` +
    topicText +
    (macroData || '') +
    (techText ? '\n\n[TEKNIK ANALIZ]\n' + techText : '') +
    (fundText ? '\n\n[TEMEL FINANSAL VERILER]\n' + fundText : '') +
    notesText + memText + decText + newsText;
  const task = customTopic
    ? 'OZEL GUNDEM: "' + customTopic + '"\nBu konuyu mevcut portfoy ve izleme listesi baglaminda degerlendirin. Ilgiliyse somut oneri cikarin (en fazla 2); degilse BEKLE deyin.'
    : 'Haftalik portfoy degerlendirmesi (uzun vadeli strateji): mevcut pozisyonlarin uzun vadeli tezleri hala gecerli mi? Izleme listesinde degerleme acisindan cazip hale gelen var mi? Sik islem onerme; guclu gerekce yoksa TUT/BEKLE de. En fazla 2 somut oneri.';

  // 2) Uc analistin oyu (phase 4 = sablonlu oy)
  const votes = [];
  const agents = [
    { key: 'claude', fn: (p, s) => callClaude([{ role: 'user', content: p }], s, context) },
    { key: 'gpt',    fn: (p, s) => callGPT([{ role: 'user', content: p }], s + '\n\n' + context) },
    { key: 'gemini', fn: (p, s) => callGemini(p, s + '\n\n' + context) }
  ];
  for (const a of agents) {
    const system = AGENT_SYSTEMS[a.key](MIDAS_STRATEGY, 4);
    const text = await a.fn(task, system);
    votes.push({ name: a.key.toUpperCase(), text });
  }

  // Hata veren analistler oylamadan ve hafizadan cikarilir
  const failed = votes.filter(v => isAgentError(v.text));
  const validVotes = votes.filter(v => !isAgentError(v.text));
  if (failed.length) console.error('[TOPLANTI] Hata veren analistler:', failed.map(v => v.name + ': ' + String(v.text).slice(0, 120)).join(' | '));
  if (!validVotes.length) {
    await sendTelegramMessage('⚠️ Toplanti yapilamadi: uc analist de hata verdi.\n' +
      failed.map(v => '• ' + v.name + ': ' + String(v.text).slice(0, 200)).join('\n'));
    return;
  }

  // 3) Baskan konsensusu (JSON)
  const chairSystem = 'Sen simule edilmis bir yatirim komitesinin baskanisın. Gorevin analist oylarini sentezleyip komite gorusu cikarmak; emir vermek degil, nihai karar kullaniciya aittir.\nKURAL: Yanitini SADECE JSON dizisi olarak ver, markdown kullanma. En fazla 2 oneri. Oneri yoksa bos dizi [] don.';
  const chairPrompt = 'Analist oylari:\n\n' + validVotes.map(v => v.name + ':\n' + v.text).join('\n\n---\n\n') +
    '\n\nJSON formati:\n[{"action":"AL/SAT/TUT/BEKLE","symbol":"AAPL","amount":100,"stopLoss":170.0,"takeProfit":200.0,"rationale":"kisa gerekce"}]';
  const rawConsensus = await callClaude([{ role: 'user', content: chairPrompt }], chairSystem, context);
  if (isAgentError(rawConsensus)) {
    await sendTelegramMessage('⚠️ Toplanti tamamlanamadi: baskan (Claude) hata verdi.\n' + String(rawConsensus).slice(0, 300));
    return;
  }

  // 4) JSON'u coz, kararlari kaydet
  let decisions = [];
  try {
    const cleaned = rawConsensus.replace(/```json|```/g, '').trim();
    decisions = JSON.parse(cleaned);
    if (!Array.isArray(decisions)) decisions = [decisions];
  } catch (e) {
    const p = parseTradeJson(rawConsensus);
    if (p.ok) decisions = [p.data];
  }

  const meetingDate = todayTR();
  const savedIds = [];
  for (const d of decisions) {
    if (!d?.action) continue;
    const id = addDecision({
      meetingDate, symbol: d.symbol || 'N/A', action: d.action,
      amount: d.amount, stopLoss: d.stopLoss, takeProfit: d.takeProfit,
      rationale: d.rationale
    });
    savedIds.push({ id, ...d });
  }

  // 5) Hafizaya yaz (hata filtresi appendMemory icinde)
  appendMemory({
    topic: customTopic ? 'Toplanti: ' + customTopic : 'Sabah portfoy toplantisi',
    portfolioId: 'midas',
    ozet: Object.fromEntries(validVotes.map(v => [v.name.toLowerCase(), String(v.text)])),
    karar: JSON.stringify(decisions),
    baskan: String(rawConsensus),
    date: meetingDate
  });

  // 6) Telegram bildirimi
  const failNote = failed.length
    ? '\n\n⚠️ Bu toplantida hata veren analist(ler): ' + failed.map(v => v.name).join(', ') + ' — oylamaya katilmadi.'
    : '';
  let msg = `🌅 ${customTopic ? 'TOPLANTI: ' + customTopic.toUpperCase() : 'SABAH TOPLANTISI'} — ${meetingDate}\n\n${posText === '(pozisyon yok)' ? '' : 'PORTFOY:\n' + posText + '\n\n'}`;
  if (savedIds.length) {
    msg += 'KOMITE ONERILERI:\n' + savedIds.map(d =>
      `#${d.id} ${d.action} ${d.symbol}` +
      (d.amount ? ` ($${d.amount})` : '') +
      (d.stopLoss ? ` | Stop: $${d.stopLoss}` : '') +
      (d.takeProfit ? ` | Hedef: $${d.takeProfit}` : '') +
      `\n   Gerekce: ${d.rationale || '-'}`
    ).join('\n\n');
    msg += '\n\nUyguladinsa + yaz, uygulamadinsa - yaz.' +
      (savedIds.length > 1 ? ' (birden fazla oneri: +' + savedIds[0].id + ' gibi numarayla)' : '');
  } else {
    msg += 'Komite bugun somut oneri cikarmadi (BEKLE).\n\nHam ozet:\n' + String(rawConsensus);
  }
  await sendTelegramMessage(msg + failNote);
  console.log('[TOPLANTI] Tamamlandi. Oneri sayisi:', savedIds.length);
}

module.exports = { runMorningMeeting };
