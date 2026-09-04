function parseTradeJson(raw) {
  try {
    const clean = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const data = JSON.parse(clean);

    if (!data.action || !data.symbol) {
      throw new Error('Eksik alan: action veya symbol');
    }

    if (!['AL', 'SAT', 'BEKLE'].includes(data.action)) {
      throw new Error('Gecersiz action: ' + data.action);
    }

    if (typeof data.amount !== 'number') {
      throw new Error('Gecersiz amount: ' + data.amount);
    }

    if (data.action !== 'BEKLE' && data.amount <= 0) {
      throw new Error('AL/SAT karari icin amount sifirdan buyuk olmali');
    }

    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { parseTradeJson };
