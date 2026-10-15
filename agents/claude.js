// agents/claude.js — Prompt caching DUZELTILDI:
// cache yalnizca icerik birebir ayni oldugunda calisir. Eski kodda portfoy
// durumu ve canli veri system'e ekleniyordu, bu yuzden her cagri cache-miss
// oluyordu. Artik: statik kimlik cache'lenir, dinamik baglam user mesajina gider.
// Not: prompt caching artik standart API'de mevcut, beta basligi kaldirildi.

async function callClaude(messages, staticSystem, dynamicContext = '') {
  try {
    const finalMessages = dynamicContext
      ? [{ role: 'user', content: '[GUNCEL BAGLAM]\n' + dynamicContext }, ...messages]
      : messages;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        max_tokens: 16000,
        system: [{ type: 'text', text: staticSystem, cache_control: { type: 'ephemeral' } }],
        messages: finalMessages
      })
    });
    const d = await r.json();
    if (d.error) { console.error('Claude hata:', d.error); return 'Hata (Claude): ' + d.error.message; }
    const textBlock = d.content?.find(b => b.type === 'text');
    return textBlock?.text || 'Bos Yanit';
  } catch (e) { return 'Claude baglanti hatasi: ' + e.message; }
}

module.exports = { callClaude };
