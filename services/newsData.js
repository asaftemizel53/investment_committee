// Haber analizi — NewsAPI ile
async function getNewsForSymbol(symbol) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return '';

  try {
    const query = encodeURIComponent(symbol + ' stock');
    const url = 'https://newsapi.org/v2/everything?q=' + query +
      '&language=en&sortBy=publishedAt&pageSize=5&apiKey=' + apiKey;

    const r = await fetch(url);
    const d = await r.json();
    if (d.status !== 'ok') {
      console.error('NewsAPI hatasi (' + symbol + '): HTTP ' + r.status + ' code=' + d.code + ' message=' + d.message);
      return '';
    }
    if (!d.articles || !d.articles.length) return '';

    const articles = d.articles.slice(0, 5);
    const lines = articles.map((a, i) => {
      const date = a.publishedAt ? a.publishedAt.substring(0, 10) : '';
      const title = a.title ? a.title.replace(/\s+/g, ' ').trim() : '';
      const source = a.source && a.source.name ? a.source.name : '';
      return (i + 1) + '. [' + date + '] ' + title + ' (' + source + ')';
    });

    return lines.join('\n');
  } catch (e) {
    console.error('Haber hatasi (' + symbol + '):', e.message);
    return '';
  }
}

async function getNewsForHistory(history) {
  if (!history || !history.length) return '';

  const ignore = ['AL', 'SAT', 'BEKLE', 'FED', 'ABD', 'ETF', 'RSI', 'MACD', 'CEO', 'KARAR', 'SEMBOL', 'N/A'];
  const text = history.slice(-3).map(h => h.text).join(' ');
  const found = text.match(/\b[A-Z]{2,5}\b/g) || [];
  const symbols = [...new Set(found)].filter(m => !ignore.includes(m)).slice(0, 2);

  if (!symbols.length) return '';

  const results = await Promise.all(symbols.map(async s => {
    const news = await getNewsForSymbol(s);
    if (!news) return null;
    return '--- ' + s + ' HABERLERI ---\n' + news;
  }));

  const valid = results.filter(Boolean);
  if (!valid.length) return '';

  return '\n\n[SON HABERLER]\n' + valid.join('\n\n');
}

async function getNewsForTopic(topic) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return { articles: [], summary: '' };

  try {
    const query = encodeURIComponent(topic);
    const url = 'https://newsapi.org/v2/everything?q=' + query +
      '&language=en&sortBy=publishedAt&pageSize=10&apiKey=' + apiKey;

    const r = await fetch(url);
    const d = await r.json();
    if (d.status !== 'ok') {
      console.error('NewsAPI hatasi (' + topic + '): HTTP ' + r.status + ' code=' + d.code + ' message=' + d.message);
      return { articles: [], summary: 'Haber servisi hatasi: ' + (d.message || 'HTTP ' + r.status) };
    }

    const articles = (d.articles || []).slice(0, 10).map(a => ({
      title: a.title,
      source: a.source && a.source.name,
      date: a.publishedAt && a.publishedAt.substring(0, 10),
      url: a.url,
      description: a.description
    }));

    const summary = articles.length
      ? articles.length + ' haber bulundu. En guncel: ' + (articles[0] && articles[0].title)
      : 'Haber bulunamadi.';

    return { articles, summary };
  } catch (e) {
    return { articles: [], summary: 'Haber cekilemedi: ' + e.message };
  }
}

module.exports = { getNewsForHistory, getNewsForTopic, getNewsForSymbol };
