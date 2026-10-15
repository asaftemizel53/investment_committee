# Investment Committee

A personal "investment committee" simulation built on multiple LLMs (Claude, GPT, Gemini). Three agents analyze stocks from different perspectives (macro/risk, technical, fundamental), a "chair" agent produces a consensus decision, decisions are delivered via Telegram, and with user approval they can be executed on an Alpaca paper trading account.

## ⚠️ Disclaimer

**This is an educational/experimental project. It is not investment advice.** The system is designed for **paper trading** (simulated trading) only. No recommendation produced by the LLMs should be treated as financial advice; all decisions and responsibility belong to the user. Review the code and the risks yourself before trading with real money.

## Architecture

```
agents/       LLM provider integrations (Claude, GPT, Gemini) and agent system prompts
routes/       Express API endpoints (agent, trade, portfolio, memory, midas, news)
services/     Business logic: market data, technical/fundamental analysis, news, meeting flow, Telegram, storage, scorecard
middleware/   Auth (x-api-key), trade rate limiting, JSON validation
```

The data layer is SQLite (`data.sqlite`, `better-sqlite3`); the portfolio, positions, watchlist, decisions and memory (summaries of past meetings) are stored there.

### How a meeting works

1. Live data is collected for every position and watchlist symbol: price, technical indicators, fundamentals, macro data (VIX, bond yields, DXY) and news headlines.
2. The three analysts each cast an independent vote (BUY / SELL / HOLD / WAIT) on the same data. They do not see each other's votes.
3. The chair (Claude) reads all three votes and writes the committee decision as JSON.
4. The decision is saved and sent to Telegram. The user replies `+` (applied) or `-` (rejected).

The analysts write their reasoning in Turkish, because the prompts are in Turkish.

## Setup

```bash
npm install
cp .env.example .env
# open .env and fill in your own API keys
node server.js
```

The server runs on `http://localhost:3000` by default.

## Features

- **3 LLM agents, 3 perspectives**: Claude (macro/risk: VIX, bonds, DXY), GPT (technical analysis: RSI, MACD, Bollinger Bands), Gemini (fundamental analysis: balance sheet metrics)
- **Technical indicators**: RSI(14), MACD(12,26,9), Bollinger Bands, SMA20/50, calculated from live price data
- **Automatic weekly meeting**: scheduled (cron) portfolio review; committee decisions are sent to Telegram
- **Telegram bot**: add/remove positions, manage the watchlist, decision feedback (+/-), persistent strategy notes
- **Scorecard**: compares the price on the day of each past decision with today's price, alongside the S&P 500 (SPY) over the same period, to show whether the committee's calls were right
- **Full meeting transcripts**: the complete text of every analyst's vote and the chair's decision is stored and viewable from Telegram
- **SQLite storage**: portfolio, positions, watchlist, decisions and meeting memory are stored persistently
- **Alpaca paper trading integration**: committee decisions can be turned into trades on a simulated account with user approval

## Telegram commands

| Command | What it does |
|---|---|
| `/portfoy SYMBOL QTY COST` | Add/update a position (buy; deducted from cash) |
| `/sil SYMBOL QTY PRICE` | Reduce/remove a position (sell; added to cash) |
| `/izle SYMBOL` / `/izlesil SYMBOL` | Add to / remove from the watchlist |
| `/liste` | Show portfolio and watchlist |
| `/toplanti [topic]` | Start a committee meeting now, optionally on a specific topic |
| `/detay` | Show the full text written by each analyst and the chair in the last meeting |
| `/karne` | Scorecard: accuracy of past decisions vs. the market |
| `/not TEXT` / `/notlar` / `/notsil ID` | Persistent strategy notes passed to every meeting |
| `/saglik` | Test that all data sources are working |
| `+` / `-` (or `+ID`) | Mark a pending decision as applied / rejected |

## License

MIT
