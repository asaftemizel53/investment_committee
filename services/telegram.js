// services/telegram.js — IKI YONLU bot.
// Eskisi sadece mesaj gonderiyordu; artik getUpdates long-polling ile
// gelen mesajlari da dinliyor ve komutlari isliyor:
//   /portfoy SEMBOL ADET MALIYET  -> pozisyon ekle/guncelle (alim, kasadan duser)
//   /sil SEMBOL ADET FIYAT        -> pozisyonu azalt/kaldir (satim, kasaya eklenir)
//   /izle SEMBOL                  -> izleme listesine ekle
//   /izlesil SEMBOL               -> izleme listesinden cikar
//   /liste                        -> portfoy + izleme listesi
//   /toplanti                     -> sabah toplantisini elle tetikle
//   /kasa [TUTAR]                 -> nakdi goster / Midas'taki nakde esitle
//   /esikler                      -> komitenin aktif alim/stop esikleri
//   /esiksil SEMBOL               -> bir sembolun esiklerini kaldir
//   /karne                        -> gecmis kararlarin dogruluk karnesi
//   /detay                        -> son toplantida analistlerin tam yazdiklari
//   + veya +2                     -> bekleyen karari UYGULANDI isaretle
//   - veya -2                     -> bekleyen karari REDDEDILDI isaretle

const {
  getPositions, upsertPosition, deletePosition,
  getWatchlist, addWatch, removeWatch,
  getPendingDecisions, setDecisionStatus,
  loadPortfolio, savePortfolio
} = require('./storage');
const { fetchQuote } = require('./marketData');
const { addNote, getNotes, deleteNote, loadMemory, getActiveThresholds, getThresholdHistory, removeThresholdsFor } = require('./storage');
const { buildScorecard } = require('./scorecard');

// Sembol dogrulama: Yahoo'da fiyati var mi? 'zorla' ile atlanabilir.
async function validateSymbol(sym) {
  const q = await fetchQuote(sym.toUpperCase());
  return q && q.price ? q.price : null;
}

const API = () => 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;

async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('Telegram bilgileri eksik.'); return; }
  try {
    // Telegram tek mesajda 4096 karakter kabul eder; uzunlari bol
    for (let i = 0; i < message.length; i += 4000) {
      await fetch(API() + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message.slice(i, i + 4000) })
      });
    }
  } catch (e) { console.log('Telegram hatasi:', e.message); }
}

function adjustCash(delta) {
  const pf = loadPortfolio('midas');
  pf.cash = Math.round((pf.cash + delta) * 100) / 100;
  savePortfolio('midas', pf);
  return pf.cash;
}

function listeText() {
  const pos = getPositions();
  const watch = getWatchlist();
  let out = 'KASA: $' + Number(loadPortfolio('midas').cash || 0).toFixed(2) + '\n\nPORTFOY (Midas):\n';
  out += pos.length
    ? pos.map(p => `• ${p.symbol}: ${p.qty} adet @ $${p.avg_cost}`).join('\n')
    : '(bos — /portfoy SEMBOL ADET MALIYET ile ekle)';
  out += '\n\nIZLEME LISTESI:\n';
  out += watch.length ? watch.map(s => '• ' + s).join('\n') : '(bos — /izle SEMBOL ile ekle)';
  return out;
}

function handleDecisionReply(text) {
  // "+", "-", "+2", "- 3" gibi formatlar
  const m = text.trim().match(/^([+-])\s*(\d+)?$/);
  if (!m) return null;
  const status = m[1] === '+' ? 'applied' : 'rejected';
  const pending = getPendingDecisions();
  if (!pending.length) return 'Bekleyen karar yok.';
  let target;
  if (m[2]) {
    target = pending.find(d => d.id === Number(m[2]));
    if (!target) return `#${m[2]} numarali bekleyen karar bulunamadi. Bekleyenler: ` + pending.map(d => '#' + d.id).join(', ');
  } else {
    if (pending.length > 1) {
      return 'Birden fazla bekleyen karar var, numarayla belirt (orn. +' + pending[0].id + '):\n' +
        pending.map(d => `#${d.id}: ${d.action} ${d.symbol}`).join('\n');
    }
    target = pending[0];
  }
  setDecisionStatus(target.id, status);
  return `Karar #${target.id} (${target.action} ${target.symbol}) ` +
    (status === 'applied' ? 'UYGULANDI olarak isaretlendi ✅' : 'REDDEDILDI olarak isaretlendi ❌');
}

async function handleCommand(text, runMeeting, runHealth) {
  const t = text.trim();

  const decisionReply = handleDecisionReply(t);
  if (decisionReply) return decisionReply;

  const [cmd, ...args] = t.split(/\s+/);
  switch (cmd.toLowerCase()) {
    case '/saglik':
      if (runHealth) { runHealth(); return 'Veri kaynaklari kontrol ediliyor, sonuc birazdan gelecek...'; }
      return 'Saglik kontrolu bagli degil.';
    case '/portfoy': {
      const [sym, qty, cost, force] = args;
      if (!sym || isNaN(qty) || isNaN(cost)) return 'Kullanim: /portfoy AAPL 10 185.50';
      if (Number(qty) <= 0 || Number(cost) <= 0) return 'Adet ve maliyet sifirdan buyuk olmali.';
      const symU = sym.toUpperCase();
      const buyQty = Number(qty);
      const buyCost = Number(cost);
      const doBuy = () => {
        const existing = getPositions().find(p => p.symbol === symU);
        const finalQty = existing ? existing.qty + buyQty : buyQty;
        const finalAvgCost = existing
          ? ((existing.qty * existing.avg_cost) + (buyQty * buyCost)) / finalQty
          : buyCost;
        upsertPosition(symU, finalQty, Math.round(finalAvgCost * 100) / 100);
        const cash = adjustCash(-(buyQty * buyCost));
        return `${symU}: ${buyQty} adet @ $${buyCost} eklendi (toplam ${finalQty} adet, ort. maliyet $${finalAvgCost.toFixed(2)}). Kasa: $${cash.toFixed(2)}`;
      };
      if (force !== 'zorla') {
        const price = await validateSymbol(sym);
        if (!price) return `⚠️ ${symU} icin fiyat bulunamadi, kaydedilmedi.\nYazimi kontrol et. BIST hissesi ise sonuna .IS ekle (orn: THYAO.IS).\nYine de eklemek istersen: /portfoy ${symU} ${qty} ${cost} zorla`;
        return doBuy() + ` (Guncel fiyat: $${price})`;
      }
      return doBuy() + ' (dogrulama atlandi).';
    }
    case '/sil': {
      const [sym, qty, price] = args;
      if (!sym || !qty || !price || isNaN(qty) || isNaN(price)) return 'Kullanim: /sil AAPL 5 195.20';
      if (Number(qty) <= 0 || Number(price) <= 0) return 'Adet ve fiyat sifirdan buyuk olmali.';
      const symU = sym.toUpperCase();
      const existing = getPositions().find(p => p.symbol === symU);
      if (!existing) return 'Boyle bir pozisyon yok.';
      const sellQty = Number(qty);
      const sellPrice = Number(price);
      if (sellQty > existing.qty) return `Elinde sadece ${existing.qty} adet ${symU} var, ${sellQty} adet satamazsin.`;
      if (sellQty === existing.qty) deletePosition(symU);
      else upsertPosition(symU, existing.qty - sellQty, existing.avg_cost);
      const cash = adjustCash(sellQty * sellPrice);
      return `${symU}: ${sellQty} adet @ $${sellPrice} satildi. Kasa: $${cash.toFixed(2)}` +
        (sellQty === existing.qty ? ' (pozisyon tamamen kapatildi)' : ` (kalan: ${existing.qty - sellQty} adet)`);
    }
    case '/izle': {
      if (!args[0]) return 'Kullanim: /izle NVDA';
      if (args[1] !== 'zorla') {
        const price = await validateSymbol(args[0]);
        if (!price) return `⚠️ ${args[0].toUpperCase()} icin fiyat bulunamadi, eklenmedi.\nBIST icin .IS ekle (orn: THYAO.IS). Yine de eklemek icin: /izle ${args[0].toUpperCase()} zorla`;
        addWatch(args[0]);
        return `${args[0].toUpperCase()} izleme listesine eklendi. (Guncel: $${price})`;
      }
      addWatch(args[0]);
      return args[0].toUpperCase() + ' izleme listesine eklendi (dogrulama atlandi).';
    }
    case '/izlesil': {
      if (!args[0]) return 'Kullanim: /izlesil NVDA';
      return removeWatch(args[0]) ? args[0].toUpperCase() + ' izlemeden cikarildi.' : 'Listede yok.';
    }
    case '/liste':
      return listeText();
    case '/toplanti': {
      const topic = args.join(' ').trim();
      if (runMeeting) {
        runMeeting(topic || undefined);
        return topic
          ? 'Toplanti baslatildi. Gundem: "' + topic + '" — sonuc birazdan gelecek...'
          : 'Toplanti baslatildi, sonuc birazdan gelecek...';
      }
      return 'Toplanti fonksiyonu bagli degil.';
    }
    case '/kasa': {
      const pf = loadPortfolio('midas');
      if (!args[0]) return 'Kasa (nakit): $' + Number(pf.cash || 0).toFixed(2) +
        '\nMidas\'taki nakitle esitlemek icin: /kasa 500';
      const amount = Number(String(args[0]).replace(',', '.').replace('$', ''));
      if (isNaN(amount) || amount < 0) return 'Kullanim: /kasa 500  (Midas\'taki nakit, dolar)';
      const old = Number(pf.cash || 0);
      pf.cash = Math.round(amount * 100) / 100;
      savePortfolio('midas', pf);
      return `Kasa guncellendi: $${old.toFixed(2)} → $${pf.cash.toFixed(2)}. Komite bir sonraki toplantida bu nakdi kullanacak.`;
    }
    case '/esikler': {
      const list = getActiveThresholds();
      if (!list.length) return 'Aktif esik yok. Komite ilk toplantida her hisse icin esik belirleyecek.';
      const lines = await Promise.all(list.map(async t => {
        const q = await fetchQuote(t.symbol);
        const hist = getThresholdHistory(t.symbol, t.kind);
        const moves = hist.length > 1 ? ' | gecmis: ' + hist.map(h => '$' + h.price).join(' → ') : '';
        const met = q?.price && q.price <= t.price;
        return `${met ? '✅' : '•'} ${t.symbol} ${t.kind === 'ALIM' ? 'alim <' : 'stop <'} $${t.price} | guncel ${q?.price ? '$' + q.price : '?'}${moves}`;
      }));
      return '🎯 AKTIF ESIKLER (✅ = gerceklesti)\n' + lines.join('\n') + '\n\nKaldirmak icin: /esiksil SEMBOL';
    }
    case '/esiksil': {
      if (!args[0]) return 'Kullanim: /esiksil COHR';
      const n = removeThresholdsFor(args[0]);
      return n ? args[0].toUpperCase() + ' esikleri kaldirildi.' : args[0].toUpperCase() + ' icin aktif esik yok.';
    }
    case '/karne':
      return await buildScorecard();
    case '/detay': {
      const last = loadMemory().slice(-1)[0];
      if (!last) return 'Henuz kayitli toplanti yok.';
      const parts = Object.entries(last.ozet || {}).map(([k, v]) => '━━ ' + k.toUpperCase() + ' ━━\n' + v);
      if (last.baskan) parts.push('━━ BASKAN (CLAUDE) KARARI ━━\n' + last.baskan);
      return '🗣 SON TOPLANTI — ' + (last.date || '') + '\n' + (last.topic || '') + '\n\n' + parts.join('\n\n') +
        (last.baskan ? '' : '\n\n(Bu toplanti eski surumde kaydedildi; metinler 300 karakterde kesilmisti.)');
    }
    case '/not': {
      const text = args.join(' ').trim();
      if (!text) return 'Kullanim: /not Iran-ABD ateskesi ilan edildi, temkinli ol';
      const id = addNote(text);
      return 'Not #' + id + ' kaydedildi. Sen silene kadar HER toplantida komiteye iletilecek.';
    }
    case '/notlar': {
      const notes = getNotes();
      return notes.length
        ? 'KALICI NOTLAR:\n' + notes.map(n => '#' + n.id + ': ' + n.text).join('\n') + '\n\nSilmek icin: /notsil NUMARA'
        : 'Kayitli not yok. Eklemek icin: /not METIN';
    }
    case '/notsil': {
      const id = Number(args[0]);
      if (!id) return 'Kullanim: /notsil 2';
      return deleteNote(id) ? 'Not #' + id + ' silindi.' : '#' + id + ' numarali not bulunamadi.';
    }
    case '/yardim':
    case '/start':
      return 'Komutlar:\n/portfoy SEMBOL ADET MALIYET (alim, kasadan duser)\n/sil SEMBOL ADET FIYAT (satim, kasaya eklenir)\n/izle SEMBOL\n/izlesil SEMBOL\n/liste\n/toplanti [konu]\n/not METIN (her toplantida komiteye iletilir)\n/notlar\n/notsil NUMARA\n/saglik (veri kaynaklarini test et)\n/kasa [TUTAR] (nakdi goster / Midas ile esitle)\n/esikler (komitenin alim/stop esikleri)\n/esiksil SEMBOL\n/karne (gecmis kararlarin dogruluk karnesi)\n/detay (son toplantida analistlerin tam yazdiklari)\n+ / - (karar geri bildirimi, coklu icin +ID)';
    default:
      return null; // taninmayan mesajlari sessizce gec
  }
}

function startTelegramListener(runMeeting, runHealth) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '');
  if (!token || !chatId) { console.log('Telegram dinleyici: bilgiler eksik, baslatilamadi.'); return; }

  let offset = 0;
  async function poll() {
    try {
      const r = await fetch(API() + `/getUpdates?timeout=30&offset=${offset}`);
      const d = await r.json();
      if (d.ok) {
        for (const u of d.result) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;
          // Sadece senin sohbetinden gelen mesajlari isle (guvenlik)
          if (String(msg.chat.id) !== chatId) continue;
          const reply = await handleCommand(msg.text, runMeeting, runHealth);
          if (reply) await sendTelegramMessage(reply);
        }
      }
    } catch (e) { /* ag hatasi — bir sonraki turda tekrar dene */ }
    setTimeout(poll, 1000);
  }
  poll();
  console.log('Telegram dinleyici aktif (komutlar + karar geri bildirimi)');
}

module.exports = { sendTelegramMessage, startTelegramListener };
