# Yatırım Komitesi

Çoklu-LLM (Claude, GPT, Gemini) tabanlı, kişisel kullanım için geliştirilmiş bir "yatırım komitesi" simülasyonu. Üç ajan farklı bakış açılarıyla (makro/risk, teknik, temel) hisse senedi tartışması yapar, bir "başkan" ajan konsensüs kararı üretir, kararlar Telegram üzerinden bildirilir ve kullanıcı onayıyla Alpaca paper trading hesabında uygulanabilir.

## ⚠️ Uyarı

**Bu bir eğitim/deney projesidir. Yatırım tavsiyesi değildir.** Sistem yalnızca **paper trading** (sanal/kağıt üzerinde işlem) için tasarlanmıştır. LLM'lerin ürettiği hiçbir öneri finansal tavsiye olarak değerlendirilmemelidir; tüm kararlar ve sorumluluk kullanıcıya aittir. Gerçek parayla işlem yapmadan önce kodu ve riskleri kendiniz değerlendirin.

## Mimari

```
agents/       LLM sağlayıcı entegrasyonları (Claude, GPT, Gemini) ve ajan sistem promptları
routes/       Express API uç noktaları (agent, trade, portfolio, memory, midas, news)
services/     İş mantığı: piyasa verisi, teknik/temel analiz, haberler, toplantı akışı, Telegram, depolama
middleware/   Auth (x-api-key), trade rate limiting, JSON doğrulama
```

Veri katmanı SQLite (`data.sqlite`, `better-sqlite3`) üzerinde; portföy, pozisyonlar, izleme listesi, kararlar ve hafıza (geçmiş toplantı özetleri) burada tutulur.

## Kurulum

```bash
npm install
cp .env.example .env
# .env dosyasını açıp kendi API anahtarlarınla doldur
node server.js
```

Sunucu varsayılan olarak `http://localhost:3000` üzerinde çalışır.

## Özellikler

- **3 LLM ajan, 3 farklı bakış açısı**: Claude (makro/risk — VIX, tahvil, DXY), GPT (teknik analiz — RSI, MACD, Bollinger Bantları), Gemini (temel analiz — bilanço metrikleri)
- **Teknik göstergeler**: RSI(14), MACD(12,26,9), Bollinger Bantları, SMA20/50 — canlı fiyat verisinden hesaplanır
- **Otomatik sabah toplantısı**: Haftalık zamanlanmış (cron) portföy değerlendirmesi, komite kararlarını Telegram'a gönderir
- **Telegram botu**: Pozisyon ekleme/silme, izleme listesi yönetimi, karar geri bildirimi (+/-), kalıcı stratejik notlar
- **SQLite depolama**: Portföy, pozisyonlar, izleme listesi, kararlar ve toplantı hafızası kalıcı olarak saklanır
- **Alpaca paper trading entegrasyonu**: Komite kararları, kullanıcı onayıyla sanal hesapta işleme dönüştürülebilir

## Lisans

MIT
