// RSI hesaplama (14 periyot)
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// EMA hesaplama
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(4));
}

// Tüm EMA değerleri dizisi
function calcEMAArray(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// MACD hesaplama (12, 26, 9)
function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = calcEMAArray(closes, 12);
  const ema26 = calcEMAArray(closes, 26);
  const offset = ema12.length - ema26.length;
  const macdLine = ema26.map((v, i) => ema12[i + offset] - v);
  if (macdLine.length < 9) return null;
  const signal = calcEMA(macdLine, 9);
  const macdValue = parseFloat(macdLine[macdLine.length - 1].toFixed(4));
  const histogram = parseFloat((macdValue - signal).toFixed(4));
  return { macd: macdValue, signal, histogram };
}

// Bollinger Bands hesaplama (20 periyot, 2 standart sapma)
function calcBollinger(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: parseFloat((sma + 2 * stdDev).toFixed(2)),
    middle: parseFloat(sma.toFixed(2)),
    lower: parseFloat((sma - 2 * stdDev).toFixed(2)),
    bandwidth: parseFloat(((4 * stdDev / sma) * 100).toFixed(2))
  };
}

// Yahoo Finance'den OHLCV verisi çek ve göstergeleri hesapla
async function getTechnicalData(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=3mo';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();

    const result = d.chart && d.chart.result && d.chart.result[0];
    if (!result) return null;

    const closes = result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
    if (!closes || closes.length < 30) return null;

    const validCloses = closes.filter(v => v !== null && v !== undefined);
    const lastPrice = validCloses[validCloses.length - 1];

    const rsi = calcRSI(validCloses, 14);
    const macd = calcMACD(validCloses);
    const bb = calcBollinger(validCloses, 20);
    const sma50 = validCloses.length >= 50 ? calcEMA(validCloses, 50) : null;
    const sma20 = calcEMA(validCloses, 20);

    // RSI yorumu
    let rsiComment = '';
    if (rsi !== null) {
      if (rsi >= 70) rsiComment = 'ASIRI ALIM (sat baskisi olabilir)';
      else if (rsi <= 30) rsiComment = 'ASIRI SATIM (tepki yukselisi olabilir)';
      else if (rsi >= 55) rsiComment = 'Yukselis momentumu';
      else if (rsi <= 45) rsiComment = 'Dusus momentumu';
      else rsiComment = 'Notr bolge';
    }

    // MACD yorumu
    let macdComment = '';
    if (macd) {
      if (macd.macd > macd.signal && macd.histogram > 0) macdComment = 'Yukselis sinyali (MACD > Signal)';
      else if (macd.macd < macd.signal && macd.histogram < 0) macdComment = 'Dusus sinyali (MACD < Signal)';
      else macdComment = 'Gecis bolgesi';
    }

    // Bollinger yorumu
    let bbComment = '';
    if (bb) {
      if (lastPrice >= bb.upper) bbComment = 'Ust bant kirilmasi - asiri alim';
      else if (lastPrice <= bb.lower) bbComment = 'Alt bant kirilmasi - asiri satim';
      else if (lastPrice > bb.middle) bbComment = 'Ust yarida, yukselis egilimi';
      else bbComment = 'Alt yarida, dusus egilimi';
    }

    const lines = [
      '--- TEKNiK GOSTERGELER: ' + symbol + ' ---',
      rsi !== null ? 'RSI(14): ' + rsi + ' -> ' + rsiComment : '',
      macd ? 'MACD: ' + macd.macd + ' | Signal: ' + macd.signal + ' | Hist: ' + macd.histogram + ' -> ' + macdComment : '',
      bb ? 'Bollinger: Alt:$' + bb.lower + ' | Orta:$' + bb.middle + ' | Ust:$' + bb.upper + ' -> ' + bbComment : '',
      sma20 ? 'SMA20: $' + sma20 : '',
      sma50 ? 'SMA50: $' + sma50 : '',
    ].filter(Boolean);

    return lines.join('\n');
  } catch (e) {
    console.error('Teknik veri hatasi (' + symbol + '):', e.message);
    return null;
  }
}

// Konusma gecmisinden sembolleri yakala ve teknik veri getir
async function getTechnicalDataForHistory(history) {
  if (!history || !history.length) return '';

  const ignore = ['AL', 'SAT', 'BEKLE', 'FED', 'ABD', 'ETF', 'RSI', 'MACD', 'CEO', 'KARAR', 'SEMBOL', 'N/A', 'YKS', 'TUM', 'PEG', 'NOT', 'PZT'];
  const text = history.slice(-3).map(h => h.text).join(' ');
  const found = text.match(/\b[A-Z\^]{2,5}\b/g) || [];
  const symbols = [...new Set(found)].filter(m => !ignore.includes(m)).slice(0, 2);

  if (!symbols.length) return '';

  const results = await Promise.all(symbols.map(s => getTechnicalData(s)));
  const valid = results.filter(Boolean);
  if (!valid.length) return '';

  return '\n\n[TEKNiK ANALiZ]\n' + valid.join('\n\n');
}

module.exports = { getTechnicalDataForHistory, getTechnicalData };
