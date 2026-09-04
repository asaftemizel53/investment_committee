const fs = require('fs');

function mkdir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function write(p, c) { fs.writeFileSync(p, c.trimStart()); console.log('✅', p); }

mkdir('services'); mkdir('agents'); mkdir('routes');
fs.copyFileSync('server.js', 'server.js.backup');
console.log('📦 server.js.backup oluşturuldu');

write('services/telegram.js', `
async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('Telegram bilgileri eksik.'); return; }
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
  } catch(e) { console.log('Telegram hatasi:', e.message); }
}
module.exports = { sendTelegramMessage };
`);

write('services/storage.js', `
const fs   = require('fs');
const path = require('path');
const MEMORY_FILE   = path.join(__dirname, '../memory.json');
const TRIGGERS_FILE = path.join(__dirname, '../triggers.json');
const pfFile = id => path.join(__dirname, '../portfolio-' + id + '.json');

const loadMemory    = ()    => { try { return JSON.parse(fs.readFileSync(MEMORY_FILE,'utf8')); }   catch(e) { return []; } };
const saveMemory    = d     => fs.writeFileSync(MEMORY_FILE,   JSON.stringify(d,null,2));
const loadTriggers  = ()    => { try { return JSON.parse(fs.readFileSync(TRIGGERS_FILE,'utf8')); } catch(e) { return []; } };
const saveTriggers  = d     => fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(d,null,2));
const savePortfolio = (id,d)=> fs.writeFileSync(pfFile(id),    JSON.stringify(d,null,2));

function loadPortfolio(id) {
  try { return JSON.parse(fs.readFileSync(pfFile(id),'utf8')); }
  catch(e) {
    const def = {
      a: { id:'a', name:'Portfoy A - Muhafazakar', cash:250, positions:[], totalValue:250, startValue:250, strategy:'Muhafazakar strategy' },
      b: { id:'b', name:'Portfoy B - Agresif',     cash:250, positions:[], totalValue:250, startValue:250, strategy:'Agresif strategy' }
    };
    return def[id] || def.a;
  }
}
module.exports = { loadMemory, saveMemory, loadTriggers, saveTriggers, loadPortfolio, savePortfolio };
`);

write('services/marketData.js', `
async function getDynamicTickerData(history) {
  if (!history || !history.length) return '';
  const ignore = ['AL','SAT','BEKLE','FED','ABD','ETF','RSI','MACD','CEO','KARAR','SEMBOL','N/A','YKS','TUM','PEG','NOT','PZT'];
  const text = history.slice(-3).map(h => h.text).join(' ');
  let matches = [...new Set((text.match(/\b[A-Z\^]{2,5}\b/g) || []))].filter(m => !ignore.includes(m));
  if (!matches.length) return '';
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + matches.slice(0,3).join(','), { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json();
    const results = d.quoteResponse?.result || [];
    if (!results.length) return '';
    const lines = results.map(q => {
      const p   = q.regularMarketPrice       ? '$' + q.regularMarketPrice                        : 'N/A';
      const pe  = q.trailingPE               ? q.trailingPE.toFixed(2)                            : 'N/A';
      const fpe = q.forwardPE                ? q.forwardPE.toFixed(2)                             : 'N/A';
      const vol = q.regularMarketVolume      ? (q.regularMarketVolume/1e6).toFixed(1)+'M'         : 'N/A';
      const avg = q.averageDailyVolume3Month ? (q.averageDailyVolume3Month/1e6).toFixed(1)+'M'    : 'N/A';
      const h52 = q.fiftyTwoWeekHigh         ? '$' + q.fiftyTwoWeekHigh                           : 'N/A';
      const l52 = q.fiftyTwoWeekLow          ? '$' + q.fiftyTwoWeekLow                            : 'N/A';
      return '► ' + q.symbol + ': ' + p + ' (52H: ' + h52 + '/' + l52 + ') | F/K: ' + pe + '/' + fpe + ' | Hacim: ' + vol + ' (Ort: ' + avg + ')';
    });
    return '\n\n[CANLI BORSA]\n' + lines.join('\n');
  } catch(e) { return ''; }
}
module.exports = { getDynamicTickerData };
`);

write('services/sentinel.js', `
const { loadTriggers, saveTriggers } = require('./storage');
const { sendTelegramMessage }        = require('./telegram');

function startSentinel() {
  setInterval(async () => {
    const triggers = loadTriggers();
    let updated = false;
    for (const t of triggers) {
      if (t.status !== 'active') continue;
      try {
        const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + t.symbol + '?interval=1d&range=1d', { headers:{'User-Agent':'Mozilla/5.0'} });
        const d = await r.json();
        const price = d.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!price) continue;
        const hit = (t.operator === '>' && price >= t.target) || (t.operator === '<' && price <= t.target);
        if (hit) {
          const msg = 'YATIRIM KOMITESI UYARISI!\n' + t.symbol + ' = $' + price + ' (Sart: ' + t.operator + ' ' + t.target + ')\nKonu: ' + t.topic;
          console.log('\n[NOBETCI]', msg, '\n');
          await sendTelegramMessage(msg);
          t.status = 'triggered';
          updated = true;
        }
      } catch(e) {}
    }
    if (updated) saveTriggers(triggers);
  }, 60000);
  console.log('Nobetci sistemi aktif');
}
module.exports = { startSentinel };
`);

write('agents/claude.js', `
async function callClaude(messages, system) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.CLAUDE_API_KEY, 'anthropic-version':'2023-06-01', 'anthropic-beta':'prompt-caching-2024-07-31' },
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:2048, system:[{ type:'text', text:system, cache_control:{type:'ephemeral'} }], messages })
    });
    const d = await r.json();
    if (d.error) { console.error('Claude hata:', d.error); return 'Hata (Claude): ' + d.error.message; }
    return d.content?.[0]?.text || 'Bos Yanit';
  } catch(e) { return 'Claude baglanti hatasi: ' + e.message; }
}
module.exports = { callClaude };
`);

write('agents/gpt.js', `
async function callGPT(messages, system) {
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer ' + process.env.OPENAI_API_KEY},
      body:JSON.stringify({ model:'gpt-4o', max_tokens:2048, messages:[{role:'system',content:system},...messages] })
    });
    const d = await r.json();
    if (d.error) { console.error('GPT hata:', d.error); return 'Hata (GPT): ' + d.error.message; }
    return d.choices?.[0]?.message?.content || 'Bos Yanit';
  } catch(e) { return 'GPT baglanti hatasi: ' + e.message; }
}
module.exports = { callGPT };
`);

write('agents/gemini.js', `
async function callGemini(prompt, system) {
  try {
    const merged = '[SISTEM]:\n' + system + '\n\n[GOREV]:\n' + prompt;
    const r = await fetch('https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ contents:[{role:'user',parts:[{text:merged}]}], generationConfig:{maxOutputTokens:8192} })
    });
    const d = await r.json();
    if (d.error) { console.error('Gemini hata:', d.error); return 'Hata (Gemini): ' + d.error.message; }
    return d.candidates?.[0]?.content?.parts?.[0]?.text || 'Bos Yanit';
  } catch(e) { return 'Gemini baglanti hatasi: ' + e.message; }
}
module.exports = { callGemini };
`);

write('agents/systems.js', `
const AGENT_SYSTEMS = {
  claude: (strategy, phase) => {
    const base = 'Sen Makro & Risk Analistisin. Portfoy: ' + strategy + '.';
    return phase === 4 ? base + '\n\nKURAL: Sadece sablonla OY ver.' : base + '\n\nKURAL: Tartis, sablon kullanma.';
  },
  gpt: (strategy, phase) => {
    const base = 'Sen Teknik Analistisin. Portfoy: ' + strategy + '.';
    return phase === 4 ? base + '\n\nKURAL: Sadece sablonla OY ver.' : base + '\n\nKURAL: Tartis, sablon kullanma.';
  },
  gemini: (strategy, phase) => {
    const base = 'Sen Temel Analistisin. Portfoy: ' + strategy + '.';
    return phase === 4 ? base + '\n\nKURAL: Sadece sablonla OY ver.' : base + '\n\nKURAL: Tartis, sablon kullanma.';
  }
};
module.exports = { AGENT_SYSTEMS };
`);

write('routes/agent.js', `
const express = require('express');
const router  = express.Router();
const { requireAuth }        = require('../middleware/auth');
const { callClaude }         = require('../agents/claude');
const { callGPT }            = require('../agents/gpt');
const { callGemini }         = require('../agents/gemini');
const { AGENT_SYSTEMS }      = require('../agents/systems');
const { loadPortfolio }      = require('../services/storage');
const { getDynamicTickerData } = require('../services/marketData');

router.post('/speak', requireAuth, async (req, res) => {
  const { agent, prompt, history, portfolioId, phase } = req.body;
  const portfolio = loadPortfolio(portfolioId || 'a');
  const pfCtx = '\n\n[PORTFOY: ' + portfolio.name + ']\n- Nakit: $' + portfolio.cash.toFixed(2);
  const dynamicData = await getDynamicTickerData(history);
  const system = AGENT_SYSTEMS[agent](portfolio.strategy, phase) + pfCtx + dynamicData;
  const fullPrompt = prompt + (history?.length ? '\n\n[GECMIS]\n' + history.map(h => h.name + ': ' + h.text).join('\n') : '');
  try {
    let text;
    if (agent === 'claude')      text = await callClaude([{role:'user',content:fullPrompt}], system);
    else if (agent === 'gpt')    text = await callGPT([{role:'user',content:fullPrompt}], system);
    else if (agent === 'gemini') text = await callGemini(fullPrompt, system);
    res.json({ text, agent, name: agent.toUpperCase(), role: '' });
  } catch(e) { res.json({ text: 'Hata: ' + e.message }); }
});

module.exports = router;
`);

write('routes/trade.js', `
const express  = require('express');
const router   = express.Router();
const Alpaca   = require('@alpacahq/alpaca-trade-api');
const { requireAuth }    = require('../middleware/auth');
const { tradeLimiter }   = require('../middleware/tradeLimiter');
const { parseTradeJson } = require('../middleware/parseTradeJson');
const { callClaude }     = require('../agents/claude');
const { loadPortfolio, loadTriggers, saveTriggers, loadMemory, saveMemory } = require('../services/storage');
const { sendTelegramMessage } = require('../services/telegram');

const alpaca = new Alpaca({ keyId: process.env.ALPACA_API_KEY, secretKey: process.env.ALPACA_SECRET_KEY, paper: true });

router.post('/consensus', requireAuth, async (req, res) => {
  const { votes, topic, portfolioId } = req.body;
  const portfolio = loadPortfolio(portfolioId || 'a');
  const system = 'Sen komite baskanisın. Portfoy: ' + portfolio.name + '.\nKURAL: Sadece JSON formatinda yanit ver. Markdown kullanma.';
  const prompt = 'Oylar:\n' + votes.map(v => v.name + ': ' + v.text).join('\n\n') + '\n\nKonu: ' + topic + '\n\nJSON formatinda yanit ver:\n{"action":"AL veya SAT veya BEKLE","symbol":"AAPL gibi","amount":100,"stopLoss":170.00,"takeProfit":200.00,"rationale":"gerekce","trigger":{"symbol":"VIX veya null","operator":"operator veya null","target":20}}';
  try {
    const raw    = await callClaude([{role:'user',content:prompt}], system);
    const parsed = parseTradeJson(raw);
    if (!parsed.ok) {
      console.error('Parse hatasi:', parsed.error);
      return res.json({ text: raw, structuredData: null, parseError: parsed.error });
    }
    const d = parsed.data;
    const lines = [
      'KONSENSUS: ' + d.action,
      'SEMBOL: '    + d.symbol,
      'MIKTAR: $'   + d.amount,
      d.stopLoss   ? 'STOP-LOSS: $' + d.stopLoss   : null,
      d.takeProfit ? 'HEDEF: $'     + d.takeProfit  : null,
      'GEREKCE: '  + d.rationale,
      d.trigger?.symbol ? 'TETIKLEYICI: ' + d.trigger.symbol + ' ' + d.trigger.operator + ' ' + d.trigger.target : 'TETIKLEYICI: N/A'
    ].filter(Boolean);
    if (d.trigger?.symbol) {
      const triggers = loadTriggers();
      triggers.push({ id:Date.now(), topic, symbol:d.trigger.symbol.toUpperCase(), operator:d.trigger.operator, target:d.trigger.target, status:'active' });
      saveTriggers(triggers);
    }
    res.json({ text: lines.join('\n'), structuredData: d });
  } catch(e) { res.json({ text: 'Hata: ' + e.message, structuredData: null }); }
});

router.post('/execute-trade', requireAuth, tradeLimiter, async (req, res) => {
  let d = req.body.structuredData;
  if (!d && req.body.consensusText) {
    const p = parseTradeJson(req.body.consensusText);
    if (!p.ok) return res.json({ ok:false, error:'Emir okunamadi: ' + p.error });
    d = p.data;
  }
  if (!d)                   return res.json({ ok:false, error:'structuredData eksik.' });
  if (d.action === 'BEKLE') return res.json({ ok:false, error:'Karar BEKLE, emir iletilmedi.' });
  try {
    const params = { symbol:d.symbol, notional:d.amount, side:d.action==='AL'?'buy':'sell', type:'market', time_in_force:'gtc', order_class:'bracket' };
    if (d.stopLoss)   params.stop_loss   = { stop_price:  d.stopLoss };
    if (d.takeProfit) params.take_profit = { limit_price: d.takeProfit };
    const order = await alpaca.createOrder(params);
    const mem = loadMemory();
    if (mem.length) { mem[mem.length-1].applied = true; saveMemory(mem); }
    await sendTelegramMessage('ALPACA: ' + d.symbol + ' $' + d.amount + ' ' + d.action + ' emri iletildi.');
    res.json({ ok:true, message: d.symbol + ' icin $' + d.amount + ' ' + d.action + ' emri iletildi.', orderId:order.id });
  } catch(e) { res.json({ ok:false, error:'Alpaca Hatasi: ' + e.message }); }
});

module.exports = router;
`);

write('routes/portfolio.js', `
const express = require('express');
const router  = express.Router();
const { requireAuth }               = require('../middleware/auth');
const { loadPortfolio, savePortfolio } = require('../services/storage');

router.get( '/portfolio/:id', (req, res) => res.json(loadPortfolio(req.params.id)));
router.post('/portfolio/:id', requireAuth, (req, res) => { savePortfolio(req.params.id, req.body); res.json({ ok:true }); });

module.exports = router;
`);

write('routes/memory.js', `
const express = require('express');
const router  = express.Router();
const { requireAuth }           = require('../middleware/auth');
const { loadMemory, saveMemory } = require('../services/storage');
const TODAY = () => new Date().toLocaleDateString('tr-TR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

router.get( '/memory', (req, res) => res.json(loadMemory()));
router.post('/save-meeting', requireAuth, (req, res) => {
  const mem = loadMemory();
  mem.push({ ...req.body, date: TODAY() });
  saveMemory(mem.slice(-100));
  res.json({ ok:true });
});

module.exports = router;
`);

write('server.js', `
const express = require('express');
require('dotenv').config();

const { startSentinel }   = require('./services/sentinel');
const agentRoutes         = require('./routes/agent');
const tradeRoutes         = require('./routes/trade');
const portfolioRoutes     = require('./routes/portfolio');
const memoryRoutes        = require('./routes/memory');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use('/api', agentRoutes);
app.use('/api', tradeRoutes);
app.use('/api', portfolioRoutes);
app.use('/api', memoryRoutes);

app.get('/api/news',          async (req, res) => res.json({ articles:[], summary:'' }));
app.get('/api/price/:symbol', async (req, res) => res.json({ price:0 }));
app.get('/api/search',        async (req, res) => res.json([]));

startSentinel();
app.listen(process.env.PORT || 3000, () => console.log('Yatirim Komitesi - http://localhost:3000'));
`);

console.log('\nMigrasyon tamamlandi!');
console.log('Klasorler: services/ agents/ routes/');
console.log('Yedek:     server.js.backup');
