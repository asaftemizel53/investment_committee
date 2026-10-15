// services/meeting.js — KOMITE TOPLANTISI (otomatik veya /toplanti ile)
// Akis: pozisyonlar + izleme listesi + kasa + aktif esikler + karne -> canli veri
// -> 3 analist oyu (sembol bazinda) -> baskan (Claude) JSON karar + esikler
// -> decisions / thresholds tablolarina kayit -> Telegram bildirimi.
// Islem gerektiren kararlar 'pending' kaydedilir, kullanici + / - ile isaretler;
// TUT/BEKLE 'bilgi' olarak kaydedilir (karnede sayilir, geri bildirim beklenmez).
// NOT: Bu toplanti HICBIR emir gondermez; Midas'ta uygulama tamamen kullanicida.

const { callClaude } = require('../agents/claude');
const { callGPT } = require('../agents/gpt');
const { callGemini } = require('../agents/gemini');
const { AGENT_SYSTEMS, CHAIR_SYSTEM } = require('../agents/systems');
const {
  getPositions, getWatchlist, addDecision, appendMemory, loadMemory, getNotes, getAllDecisions,
  loadPortfolio, getActiveThresholds, getThresholdHistory, setThreshold, markThresholdHit
} = require('./storage');
const { getQuotesFor, formatQuote, resolveSymbols } = require('./marketData');
const { getMacroData } = require('./macroData');
const { getTechnicalData } = require('./technicalIndicators');
const { getFundamentalData } = require('./fundamentalData');
const { sendTelegramMessage } = require('./telegram');
const { getNewsForTopic } = require('./newsData');
const { scorecardSummary } = require('./scorecard');

const MIDAS_STRATEGY = 'Gercek Midas portfoyu. Amac: uzun vadede portfoy degerini buyutmek; mevcut pozisyonlari degerlendirmek ve izleme listesindeki sirketleri dogru fiyattan almak. Kullanici islemleri Midas uzerinden elle yapar.';

const ACTION_NEEDED = ['AL', 'KADEMELI AL', 'AZALT', 'SAT'];
const VALID_ACTIONS = [...ACTION_NEEDED, 'TUT', 'BEKLE'];

function todayTR() {
  return new Date().toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function shortDate(sqliteUtc) {
  return new Date(String(sqliteUtc).replace(' ', 'T') + 'Z')
    .toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
}
const usd = n => '$' + Number(n).toFixed(2);

// Model hata metnini (API hatasi, baglanti hatasi, bos yanit) gecerli oydan ayir
function isAgentError(text) {
  const t = String(text || '');
  return /^Hata \((Claude|GPT|Gemini)\)/.test(t) || /baglanti hatasi/i.test(t) || t === 'Bos Yanit';
}

// ALIM esigi: fiyat esigin altina indiyse gerceklesti. STOP: fiyat stop'un altina indiyse.
function isThresholdMet(t, price) {
  return price != null && price <= t.price;
}

// Baskanin JSON'u: { ozet, kararlar, esikler }. Eski format (dizi) da kabul edilir.
function parseChair(raw) {
  const cleaned = String(raw).replace(/```json|```/g, '').trim();
  const tryParse = txt => { try { return JSON.parse(txt); } catch (e) { return null; } };
  let obj = tryParse(cleaned);
  if (!obj) {
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a !== -1 && b > a) obj = tryParse(cleaned.slice(a, b + 1));
  }
  if (Array.isArray(obj)) obj = { ozet: '', kararlar: obj, esikler: [] };
  if (!obj || typeof obj !== 'object') return null;
  return {
    ozet: String(obj.ozet || ''),
    kararlar: Array.isArray(obj.kararlar) ? obj.kararlar : [],
    esikler: Array.isArray(obj.esikler) ? obj.esikler : []
  };
}

// Ayni anda iki toplanti calismasin (cift /toplanti, cron + elle tetikleme, nobetci)
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
    await sendTelegramMessage('Toplanti atlandi: portfoy ve izleme listesi bos.\n/portfoy ve /izle komutlariyla ekleme yap.');
    return;
  }

  // 1) Canli veri: fiyatlar + makro ortam + her sembolun teknik ve temel verisi.
  // Gundemde adi gecen sirketler (orn. "SpaceX" -> SPCX) canli veriyle eklenir;
  // aksi halde modeller eski egitim bilgisine doner.
  const topicSymbols = customTopic ? await resolveSymbols(customTopic) : [];
  const thresholds = getActiveThresholds();
  const symbols = [...new Set([
    ...topicSymbols.map(t => t.symbol), ...positions.map(p => p.symbol), ...watchlist, ...thresholds.map(t => t.symbol)
  ].map(s => s.toUpperCase()))];
  const newsQuery = customTopic || 'stock market economy Fed';
  const [quotes, macroData, techResults, fundResults, topicNews, scoreText] = await Promise.all([
    getQuotesFor(symbols),
    getMacroData(),
    Promise.all(symbols.map(s => getTechnicalData(s))),
    Promise.all(symbols.map(s => getFundamentalData(s))),
    getNewsForTopic(newsQuery).catch(() => ({ articles: [] })),
    scorecardSummary()
  ]);
  const quoteMap = Object.fromEntries(quotes.map(q => [q.symbol.toUpperCase(), q]));
  const priceOf = s => quoteMap[String(s).toUpperCase()]?.price ?? null;
  const techText = techResults.filter(Boolean).join('\n\n');
  const fundText = fundResults.filter(Boolean).join('\n\n');

  // Kasa ve portfoy agirliklari — komite gercek nakdi bilmeden boyut onermesin
  const cash = Number(loadPortfolio('midas').cash) || 0;
  const posValue = positions.reduce((sum, p) => sum + p.qty * (priceOf(p.symbol) ?? p.avg_cost), 0);
  const totalValue = cash + posValue;
  const cashText = `\n\n[KASA]\n• Nakit: ${usd(cash)}\n• Pozisyonlarin guncel degeri: ${usd(posValue)}\n• Toplam portfoy: ${usd(totalValue)}\n` +
    `• Tek pozisyon ust siniri (%25): ${usd(totalValue * 0.25)}`;

  const posText = positions.length
    ? positions.map(p => {
        const cur = priceOf(p.symbol);
        const pnl = cur ? (((cur - p.avg_cost) / p.avg_cost) * 100).toFixed(2) + '%' : 'N/A';
        const weight = cur && totalValue ? ((p.qty * cur) / totalValue * 100).toFixed(1) + '%' : 'N/A';
        return `• ${p.symbol}: ${p.qty} adet @ $${p.avg_cost} | Guncel: ${cur ? '$' + cur : 'N/A'} | K/Z: ${pnl} | Portfoy payi: ${weight}`;
      }).join('\n')
    : '(pozisyon yok)';
  const watchText = watchlist.length
    ? watchlist.map(s => quoteMap[s.toUpperCase()] ? formatQuote(quoteMap[s.toUpperCase()]) : '► ' + s + ': veri yok').join('\n')
    : '(izleme listesi bos)';

  const topicText = topicSymbols.length
    ? '\n\n[GUNDEMDEKI SIRKETLER — CANLI BORSA VERISI]\n' + topicSymbols.map(t => {
        const q = quoteMap[t.symbol.toUpperCase()];
        return '• ' + t.term + ' = ' + t.name + ' (' + t.symbol + (t.exchange ? ', ' + t.exchange : '') + ', HALKA ACIK): ' +
          (q ? formatQuote(q).replace(/^► /, '') : 'fiyat alinamadi');
      }).join('\n')
    : '';

  // Aktif esikler + gecmisi: komite esigi gecmiste nasil kaydirdigini gorsun
  const thresholdText = thresholds.length
    ? '\n\n[AKTIF ESIKLER — KOMITENIN DAHA ONCE TAAHHUT ETTIGI FIYATLAR]\n' + thresholds.map(t => {
        const cur = priceOf(t.symbol);
        const met = isThresholdMet(t, cur);
        const hist = getThresholdHistory(t.symbol, t.kind);
        const histText = hist.length > 1
          ? ' | Esik gecmisi: ' + hist.map(h => usd(h.price) + ' (' + shortDate(h.created_at) + ')').join(' → ')
          : '';
        const label = t.kind === 'ALIM' ? 'ALIM esigi (bu fiyatin altinda al)' : 'STOP (bu fiyatin altinda cik)';
        return `• ${t.symbol} ${label}: ${usd(t.price)}, ${shortDate(t.created_at)} tarihinden beri | Guncel: ${cur != null ? usd(cur) : 'N/A'} | ` +
          (met ? `DURUM: GERCEKLESTI (fiyat esigin %${((t.price - cur) / t.price * 100).toFixed(1)} altinda)` : 'DURUM: henuz gerceklesmedi') +
          (t.reason ? ` | Esik gerekcesi: ${t.reason}` : '') + histText;
      }).join('\n')
    : '\n\n[AKTIF ESIKLER]\n(henuz kayitli esik yok — bu toplantida her hisse icin belirleyin)';

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
  const stMap = { applied: 'UYGULANDI', rejected: 'REDDEDILDI', pending: 'BEKLIYOR', bilgi: 'BILGI' };
  const recentDecs = getAllDecisions().slice(0, 20);
  const decText = recentDecs.length
    ? '\n\n[SON KOMITE KARARLARI VE KULLANICI GERI BILDIRIMI]\n' +
      recentDecs.map(d => '• #' + d.id + ' ' + d.action + ' ' + d.symbol + ' -> ' + (stMap[d.status] || d.status)).join('\n')
    : '';

  const scoreBlock = scoreText ? '\n\n[KOMITE KARNESI — GECMIS KARARLARIN SONUCU]\n' + scoreText : '';

  // Guncel haber basliklari
  const newsText = (topicNews.articles || []).length
    ? '\n\n[GUNCEL HABER BASLIKLARI: ' + newsQuery + ']\n' +
      topicNews.articles.map(a => '• [' + (a.date || '') + '] ' + a.title + ' (' + (a.source || '') + ')').join('\n')
    : '';

  const context = `[TARIH] ${todayTR()}` + cashText +
    `\n\n[MEVCUT PORTFOY - MIDAS]\n${posText}\n\n[IZLEME LISTESI]\n${watchText}` +
    topicText + thresholdText +
    (macroData || '') +
    (techText ? '\n\n[TEKNIK ANALIZ]\n' + techText : '') +
    (fundText ? '\n\n[TEMEL FINANSAL VERILER]\n' + fundText : '') +
    notesText + memText + decText + scoreBlock + newsText;

  const agenda = 'Gundemdeki semboller: ' + symbols.join(', ') + '.';
  const task = customTopic
    ? 'OZEL GUNDEM: "' + customTopic + '"\nBu konuyu mevcut portfoy, kasa ve izleme listesi baglaminda degerlendirin. ' + agenda +
      ' Her sembol icin oy formatini doldurun.'
    : 'Haftalik portfoy degerlendirmesi (uzun vadeli strateji): mevcut pozisyonlarin tezleri hala gecerli mi? ' +
      'Izleme listesinde degerleme acisindan alinabilir hale gelen var mi? Gerceklesmis esikler var mi? ' + agenda +
      ' Her sembol icin oy formatini doldurun.';

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

  // 3) Baskan karari (JSON: ozet + kararlar + esikler)
  const chairPrompt = 'Analist oylari:\n\n' + validVotes.map(v => v.name + ':\n' + v.text).join('\n\n---\n\n') +
    '\n\n' + agenda + ' Komite kararini istenen JSON yapisinda yaz.';
  const rawConsensus = await callClaude([{ role: 'user', content: chairPrompt }], CHAIR_SYSTEM, context);
  if (isAgentError(rawConsensus)) {
    await sendTelegramMessage('⚠️ Toplanti tamamlanamadi: baskan (Claude) hata verdi.\n' + String(rawConsensus).slice(0, 300));
    return;
  }
  const chair = parseChair(rawConsensus);
  if (!chair) console.error('[TOPLANTI] Baskan JSON okunamadi:', String(rawConsensus).slice(0, 300));
  const { ozet = '', kararlar = [], esikler = [] } = chair || {};

  // 4) Kararlari kaydet
  const meetingDate = todayTR();
  const saved = [];
  for (const d of kararlar) {
    const action = String(d?.action || '').toUpperCase().trim();
    if (!VALID_ACTIONS.includes(action) || !d.symbol) continue;
    const id = addDecision({
      meetingDate, symbol: String(d.symbol).toUpperCase(), action,
      amount: d.amount, stopLoss: d.stopLoss, takeProfit: d.takeProfit,
      rationale: d.rationale,
      status: ACTION_NEEDED.includes(action) ? 'pending' : 'bilgi'
    });
    saved.push({ id, ...d, action, symbol: String(d.symbol).toUpperCase() });
  }

  // 5) Esikleri kaydet; asagi kaydirilan ALIM esiklerini isaretle
  const thresholdChanges = [];
  for (const e of esikler) {
    const kind = String(e?.kind || '').toUpperCase();
    const price = Number(e?.price);
    if (!['ALIM', 'STOP'].includes(kind) || !e.symbol || !(price > 0)) continue;
    if (!symbols.includes(String(e.symbol).toUpperCase())) continue; // gundem disi sembole esik konmaz
    const { id, previous } = setThreshold({ symbol: e.symbol, kind, price, reason: e.esik_gerekcesi });
    // Konuldugu anda zaten gerceklesmis esik nobetciyi tetiklemesin (her dakika
    // yeni toplanti dongusu olusmasin); komite bu durumu zaten bu toplantida gordu.
    if (isThresholdMet({ price }, priceOf(e.symbol))) markThresholdHit(id);
    thresholdChanges.push({ symbol: String(e.symbol).toUpperCase(), kind, price, previous, reason: e.esik_gerekcesi });
  }

  // 6) Hafizaya yaz (hata filtresi appendMemory icinde)
  appendMemory({
    topic: customTopic ? 'Toplanti: ' + customTopic : 'Haftalik portfoy toplantisi',
    portfolioId: 'midas',
    ozet: Object.fromEntries(validVotes.map(v => [v.name.toLowerCase(), String(v.text)])),
    karar: JSON.stringify({ ozet, kararlar, esikler }),
    baskan: String(rawConsensus),
    date: meetingDate
  });

  // 7) Telegram bildirimi
  const failNote = failed.length
    ? '\n\n⚠️ Bu toplantida hata veren analist(ler): ' + failed.map(v => v.name).join(', ') + ' — oylamaya katilmadi.'
    : '';
  let msg = `🌅 ${customTopic ? 'TOPLANTI: ' + customTopic.toUpperCase() : 'HAFTALIK TOPLANTI'} — ${meetingDate}\n` +
    `Kasa: ${usd(cash)} | Toplam portfoy: ${usd(totalValue)}\n`;
  if (ozet) msg += `\nKOMITE GORUSU:\n${ozet}\n`;

  const actions = saved.filter(d => ACTION_NEEDED.includes(d.action));
  const others = saved.filter(d => !ACTION_NEEDED.includes(d.action));
  if (actions.length) {
    msg += '\n🔔 ISLEM ONERILERI:\n' + actions.map(d =>
      `#${d.id} ${d.action} ${d.symbol}` +
      (d.amount ? ` ($${d.amount})` : '') +
      (d.stopLoss ? ` | Stop: $${d.stopLoss}` : '') +
      (d.takeProfit ? ` | Hedef: $${d.takeProfit}` : '') +
      `\n   Gerekce: ${d.rationale || '-'}`
    ).join('\n\n');
    msg += '\n\nUyguladinsa + yaz, uygulamadinsa - yaz.' +
      (actions.length > 1 ? ' (birden fazla oneri: +' + actions[0].id + ' gibi numarayla)' : '');
  } else {
    msg += '\nIslem onerisi yok.';
  }
  if (others.length) {
    msg += '\n\nDIGER HISSELER:\n' + others.map(d => `• ${d.action} ${d.symbol}: ${d.rationale || '-'}`).join('\n');
  }
  if (thresholdChanges.length) {
    msg += '\n\n🎯 ESIKLER:\n' + thresholdChanges.map(c => {
      const label = c.kind === 'ALIM' ? 'alim <' : 'stop <';
      let line = `• ${c.symbol} ${label} ${usd(c.price)}`;
      if (c.previous) {
        const down = c.price < c.previous.price;
        line += ` (onceki ${usd(c.previous.price)}${c.kind === 'ALIM' && down ? ' ⚠️ ASAGI KAYDIRILDI' : ''})`;
        if (c.kind === 'ALIM' && down) line += `\n   Gerekce: ${c.reason || '(yazilmadi)'}`;
      }
      return line;
    }).join('\n');
  }
  if (!chair) msg += '\n\n⚠️ Baskanin cevabi okunamadi, ham metin:\n' + String(rawConsensus);
  msg += '\n\nAnalistlerin tam metni: /detay';
  await sendTelegramMessage(msg + failNote);
  console.log('[TOPLANTI] Tamamlandi. Islem onerisi:', actions.length, '| Esik:', thresholdChanges.length);
}

module.exports = { runMorningMeeting, isThresholdMet };
