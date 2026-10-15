// services/newsData.js — Haberler, UC KAYNAKTAN:
//   1) Yahoo Finance (search endpoint)  -> hisseye ozel, anahtarsiz, dakikalar icinde guncel
//   2) Google News RSS                  -> konu bazli (Fed, birlesme...), anahtarsiz, guncel
//   3) NewsAPI                          -> YEDEK; ucretsiz planda haberler gunlerce gecikmeli
// Google aramasi daha isabetli, Yahoo ise hisse etiketli ama genis (orn. SPCX
// altinda Tesla Roadster haberleri). Bu yuzden Google oncelikli, Yahoo tamamlayici;
// tekrarlar elenir, yeniden eskiye siralanir. Ikisi de bossa NewsAPI.
// Fonksiyon imzalari eskisiyle ayni.

const UA = { 'User-Agent': 'Mozilla/5.0' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

function toArticle(title, source, ts, url, description) {
  return {
    title, source: source || '', url: url || '', description: description || '',
    date: ts ? new Date(ts).toISOString().slice(0, 10) : '',
    ts: ts || 0
  };
}

// --- 1) Yahoo Finance ---
async function fetchYahooNews(query, limit = 8) {
  try {
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(query) +
      '&quotesCount=0&newsCount=' + limit;
    const r = await fetch(url, { headers: UA });
    const d = await r.json();
    return (d.news || [])
      .filter(n => n.title)
      .map(n => toArticle(decodeEntities(n.title), n.publisher, (n.providerPublishTime || 0) * 1000, n.link));
  } catch (e) {
    console.error('Yahoo haber hatasi (' + query + '):', e.message);
    return [];
  }
}

// --- 2) Google News RSS ---
async function fetchGoogleNews(query, limit = 10, days = 2) {
  try {
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query + ' when:' + days + 'd') +
      '&hl=en-US&gl=US&ceid=US:en';
    const r = await fetch(url, { headers: UA });
    const xml = await r.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.slice(0, limit).map(it => {
      const tag = name => (it.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>')) || [])[1] || '';
      const source = decodeEntities(tag('source'));
      let title = decodeEntities(tag('title'));
      // Google basliga " - Yayinci" ekliyor; kaynak zaten ayri alanda
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
      const ts = Date.parse(tag('pubDate')) || 0;
      return toArticle(title, source, ts, decodeEntities(tag('link')));
    }).filter(a => a.title);
  } catch (e) {
    console.error('Google News hatasi (' + query + '):', e.message);
    return [];
  }
}

// --- 3) NewsAPI (yedek) ---
async function fetchNewsApi(query, limit = 10) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) return [];
  try {
    const url = 'https://newsapi.org/v2/everything?q=' + encodeURIComponent(query) +
      '&language=en&sortBy=publishedAt&pageSize=' + limit + '&apiKey=' + apiKey;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status !== 'ok') {
      console.error('NewsAPI hatasi (' + query + '): HTTP ' + r.status + ' code=' + d.code + ' message=' + d.message);
      return [];
    }
    return (d.articles || []).filter(a => a.title).map(a => toArticle(
      a.title.replace(/\s+/g, ' ').trim(), a.source && a.source.name,
      Date.parse(a.publishedAt) || 0, a.url, a.description));
  } catch (e) {
    console.error('NewsAPI hatasi (' + query + '):', e.message);
    return [];
  }
}

// Ayni haberin farkli kaynaklardan gelen kopyalarini ele, yeniden eskiye sirala
function mergeArticles(lists, limit) {
  const seen = new Set();
  const out = [];
  for (const a of lists.flat().sort((x, y) => y.ts - x.ts)) {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.slice(0, limit);
}

function formatLines(articles) {
  return articles.map((a, i) => (i + 1) + '. [' + a.date + '] ' + a.title + (a.source ? ' (' + a.source + ')' : '')).join('\n');
}

// Hisse haberleri: metin doner (eski imza)
async function getNewsForSymbol(symbol) {
  const [google, yahoo] = await Promise.all([fetchGoogleNews(symbol + ' stock', 5, 3), fetchYahooNews(symbol, 5)]);
  let articles = mergeArticles([google.slice(0, 3), yahoo.slice(0, 3)], 5);
  if (!articles.length) articles = mergeArticles([await fetchNewsApi(symbol + ' stock', 5)], 5);
  return articles.length ? formatLines(articles) : '';
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

// Konu haberleri: { articles, summary } doner (eski imza).
// summary, web arayuzunde modellere [GUNDEM HABER OZETI] olarak gider.
async function getNewsForTopic(topic) {
  const [google, yahoo] = await Promise.all([fetchGoogleNews(topic, 10), fetchYahooNews(topic, 8)]);
  let articles = mergeArticles([google.slice(0, 7), yahoo.slice(0, 3)], 10);
  if (!articles.length) articles = mergeArticles([await fetchNewsApi(topic, 10)], 10);

  const summary = articles.length
    ? articles.length + ' guncel haber (en yeni once):\n' + formatLines(articles.slice(0, 6))
    : 'Haber bulunamadi.';
  return { articles, summary };
}

module.exports = {
  getNewsForHistory, getNewsForTopic, getNewsForSymbol,
  fetchYahooNews, fetchGoogleNews, fetchNewsApi
};
