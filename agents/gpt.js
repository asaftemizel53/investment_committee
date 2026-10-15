async function callGPT(messages, system) {
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        max_completion_tokens: 16000,
        messages: [{ role: 'system', content: system }, ...messages]
      })
    });
    const d = await r.json();
    if (d.error) {
      console.error('GPT hata:', d.error);
      return 'Hata (GPT): ' + d.error.message;
    }
    return (d.choices && d.choices[0] && d.choices[0].message.content) || 'Bos Yanit';
  } catch (e) {
    return 'GPT baglanti hatasi: ' + e.message;
  }
}

module.exports = { callGPT };
