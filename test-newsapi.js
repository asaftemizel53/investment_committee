// test-newsapi.js — NEWS_API_KEY ile basit bir istek atip ham cevabi gosterir (tek seferlik teshis)
require('dotenv').config();

async function main() {
  const apiKey = process.env.NEWS_API_KEY;
  console.log('NEWS_API_KEY mevcut mu:', !!apiKey);
  console.log('NEWS_API_KEY uzunluk:', apiKey ? apiKey.length : 0);
  if (!apiKey) {
    console.log('HATA: .env icinde NEWS_API_KEY bulunamadi (process.env uzerinden).');
    return;
  }

  const url = 'https://newsapi.org/v2/everything?q=AAPL%20stock&language=en&sortBy=publishedAt&pageSize=5&apiKey=' + apiKey;
  console.log('\nIstek atiliyor:', url.replace(apiKey, '<REDACTED>'));

  try {
    const r = await fetch(url);
    console.log('\nHTTP status:', r.status, r.statusText);
    console.log('Response headers:');
    for (const [k, v] of r.headers.entries()) console.log(' ', k + ':', v);

    const text = await r.text();
    console.log('\nHam govde:');
    console.log(text);
  } catch (e) {
    console.log('\nFETCH HATASI:', e.message);
    console.log('cause:', e.cause);
    console.log('stack:', e.stack);
  }
}

main();
