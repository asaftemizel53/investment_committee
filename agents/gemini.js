async function callGemini(prompt, system) {
  try {
    const merged = '[SISTEM]:\n' + system + '\n\n[GOREV]:\n' + prompt;
    const url = 'https://generativelanguage.googleapis.com/v1/models/gemini-3.6-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: merged }] }],
        generationConfig: { maxOutputTokens: 16384 }
      })
    });
    const d = await r.json();
    if (d.error) {
      console.error('Gemini hata:', d.error);
      return 'Hata (Gemini): ' + d.error.message;
    }
    return (d.candidates && d.candidates[0] && d.candidates[0].content.parts[0].text) || 'Bos Yanit';
  } catch (e) {
    return 'Gemini baglanti hatasi: ' + e.message;
  }
}

module.exports = { callGemini };
