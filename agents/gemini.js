// Model: Gemini 4 Argon — Google'in en guclu modeli, dusuk halusinasyon orani
// (temel analist rakamlarla calistigi icin onemli). Dusunen bir model oldugu
// icin dusunme tokenlari da maxOutputTokens'tan yer; limit modelin ust sinirinda.
const GEMINI_MODEL = 'gemini-4-argon';

async function callGemini(prompt, system) {
  try {
    const merged = '[SISTEM]:\n' + system + '\n\n[GOREV]:\n' + prompt;
    const url = 'https://generativelanguage.googleapis.com/v1/models/' + GEMINI_MODEL + ':generateContent?key=' + process.env.GEMINI_API_KEY;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: merged }] }],
        generationConfig: { maxOutputTokens: 32768 }
      })
    });
    const d = await r.json();
    if (d.error) {
      console.error('Gemini hata:', d.error);
      return 'Hata (Gemini): ' + d.error.message;
    }
    // Cevap birden fazla parcaya bolunebilir; dusunce parcalari haric hepsini birlestir
    const parts = d.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
    return text || 'Bos Yanit';
  } catch (e) {
    return 'Gemini baglanti hatasi: ' + e.message;
  }
}

module.exports = { callGemini };
