# Data quality — Implied World

This desk freezes Bitget-tagged inputs. Every numeric field carries a tag:

| Tag | Plain word | Meaning |
|-----|------------|---------|
| `observed` | Observed | Printed from a live MCP response |
| `computed` | Computed | Derived from calendar / formula (e.g. hours to cash open) |
| `assumed` | Assumed | Placeholder or heuristic; desk still runs |
| `source_failed` | Failed | Feed unreachable or empty; never dressed up as live |
| `targeted` | Assumed | User/scenario override (shown as Assumed in the strip) |

## Bitget US catalog (`https://agent.bitget.com/mcp`)

Tools: `guide`, `do_query`.

### Cash equity
- `equity_price_quote` — live US equity last / prev_close (cash leg)

### Wrapper / rToken (closest observed)
There is **no** catalog entry literally named `rToken`.

Closest observed wrappers found via `guide` (crypto category) and live `do_query`:

| entry_id | Role |
|----------|------|
| `crypto_market` (`is_rwa` / `base=NVDA`, `category=stock`) | Lists Bitget/Binance/Bybit `NVDA/USDT` RWA stock perpetuals |
| `crypto_futures_ticker` (`symbol=NVDAUSDT`, `exchange=bitget`) | **Live wrapper last** used as rToken leg |
| `crypto_coin_info` (`symbol=NVDA`) | Tokenized stock metadata (e.g. Robinhood NVDA token) — fallback |
| `crypto_futures_order_book` | Bid/ask + depth for thin-wrapper flag |

Desk wiring (`shared/bitget-us.js`):
1. Cash from `equity_price_quote` / prev_close
2. rToken from `crypto_futures_ticker` on Bitget (separate from cash)
3. Thin wrapper from `crypto_futures_order_book` when present; else premium heuristic tagged **assumed**

If futures ticker and coin_info both fail, rToken falls back to equity last or cash×(1+0.6%) and is tagged **assumed** with a note — never silent “live”.

## Bitget signal (`https://datahub.noxiaohao.com/mcp`)

**Profiled (2026-09-23):** `crypto_price`, `crypto_market`, `global_assets`, `tradfi_news`, and `news_feed` hang (≥8–12s).  
**Fast path:** `crypto_derivatives` `ticker_24h` for `BTC/USDT` responds ~200–300ms with `change_pct` (percent units → stored as decimal).

### BTC 24h return (prefer observed)
1. Signal `crypto_derivatives` / `ticker_24h` — tagged `observed` / `bitget-signal`
2. Bitget US `do_query` `crypto_futures_ticker` `BTCUSDT` — tagged `observed` / `bitget-us` (never labelled as signal)
3. CoinGecko public `simple/price` — tagged `observed` / `coingecko-public` (last resort; Binance public is geo-blocked here)

Per-call timeout: `SIGNAL_BTC_TIMEOUT_MS` (default 12s). No shared budget that kills siblings.

### Nasdaq last session
Signal `global_assets` hangs — skip Signal. Use Bitget US `equity_price_quote` QQQ `(last − prev_close) / prev_close`, tagged `observed` / `bitget-us`. Timeout `SIGNAL_NASDAQ_TIMEOUT_MS` (default 12s).

### Event class
Prefer fast Signal tools with short timeouts:
1. `news_feed` (headlines) ~4s
2. `macro_indicators` (macro calendar) ~4s
3. `tradfi_news` only when `SIGNAL_TRY_EVENTS=1` (profiled hang; last resort)

Tag rules:
- **observed** — only when a *dated* matching item is found (earnings / cpi_fomc / geopolitics)
- **assumed** — intentional skip, or tools returned OK but no dated match (“No event was verified” — not “none exists”)
- **source_failed** — timeout / unreachable / tool error (still `event_class=none` for numbers)

Never invent earnings or FOMC. Timeout `SIGNAL_EVENT_TIMEOUT_MS` (default 8s).

## Hours to cash open

`hoursToOpen` and alias `hoursToCashOpen` are always populated (`computed`, or `assumed` only if ET instant search fails and a UTC-offset fallback is used).

## Qwen writeup

Timeout `QWEN_TIMEOUT_MS` (default 50s; overridable). `QWEN_MAX_TOKENS` default 420; temperature 0.15.  
Prompt sends only a **compact frozen table** (symbol, cash, rtoken, premium, residual, event, hours, band, firstToDie, factor, lamp) — not the full response blob. Instructs 4–6 short plain sentences; only those numbers; call out assumed/failed; no BUY/SELL/LONG/SHORT; no hype.  
On timeout/fail: `briefing: null` + `briefing_error`; numeric desk still returns first.
