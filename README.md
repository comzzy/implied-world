# Implied World

Overnight rToken decision stress desk for NVDA, TSLA, and AAPL.

**Human decides. This desk does not trade.**

The desk freezes tagged market inputs, solves an auditable implied-gap band, runs stress / twin / factor / size checks, and can draft a briefing from that frozen table. It never places orders and never prints trade-direction language (BUY / SELL / LONG / SHORT).

## Scope

US equity rTokens over a weekend or event window: check whether live wrapper premium already consumes the implied gap to the next cash open, after BTC residual and event importance — without recommending a side.

## How to run

```bash
cp .env.example .env   # then set BITGET_QWEN_API_KEY if you have one
npm install
npm start
```

Open `http://127.0.0.1:3847` (or the `PORT` in `.env`).

Health: `GET /api/health`  
Desk: `POST /api/implied-world` with `{ "symbol":"NVDA", "thesis":"…", "style":"weekend_swing", "notionalUsdt":5000 }`

Sanitize self-test:

```bash
npm run test:sanitize
# or
node -e "const {sanitizeText}=require('./shared/sanitize'); const o=sanitizeText('BUY NVDA'); if(/BUY/i.test(o)) process.exit(1); console.log('PASS', o);"
```

## Math (published constants)

| Constant | Value | Role |
|----------|-------|------|
| `k` | `0.4` | Residual weight |
| `stress_pad` default | `0.008` (0.8%) | Half-width of the band before time decay |

**Premium**

```
premium = (rtoken − cash) / cash
```

**Implied gap (F1)**

```
implied_gap_mid = premium + k × event_importance × residual_btc
implied_gap_lo  = mid − stress_pad
implied_gap_hi  = mid + stress_pad
```

`event_importance` ∈ [0, 1] from event class (`none` 0.1 · `geopolitics` 0.45 · `cpi_fomc` 0.7 · `earnings` 0.85).

**Status (no side encoded)**

- `NO_ROOM` — live premium ≥ `implied_gap_hi`
- `ROOM_LEFT` — inside / below the band without thin+event instability
- `OPEN_BUT_UNSTABLE` — far below band + real event + thin wrapper book

**Decay (F2)**

```
pad_now = stress_pad × clamp(hours_to_cash_open / 48, 0.25, 1)
```

Compare `band_now` vs `band_if_friday_night` (~63h pad factor).

**Channels (F3)** — name / btc_residual / wrapper percentages (~100%), labels only.

**Size (F4)** — `size_eats_room_bps` from spread/depth estimate vs band width.

**Stress (F5)** — presets: event→0, wrapper +1.5%, BTC residual −3%. Reports `firstToDie`. Sliders recompute client-side from frozen JSON — they do not call the writer.

**Twin (F6)** — invert residual sign and complement event importance; still no side.

**Factor (F7)** — same-hour premiums across NVDA/TSLA/AAPL → `NAME` | `FACTOR_NOT_NAME`.

**Receipt (F8)** — lamp `ALIGNED` | `CONTESTED`; copyable text on NO_ROOM / flip.

Every figure is tagged `observed` | `assumed` | `targeted` | `source_failed`.

## Briefing writer

The writer **writes only**. Freeze numbers are ground truth. If the writer invents prices, the desk ignores them for maths. If the key is missing or the call fails, the API still returns the full numeric desk with `briefing: null` and an error note.

Env (see `.env.example` — never commit real keys):

```
BITGET_QWEN_API_KEY=
QWEN_BASE_URL=https://hackathon.bitgetops.com/v1
QWEN_MODEL=qwen3.8-max
PORT=3847
```

## Market feeds

- Cash / US feed: `https://agent.bitget.com/mcp` (`shared/bitget-us.js`) — quotes / klines / profile via JSON-RPC `tools/list` + `tools/call` (SSE or JSON).
- Residual / signal feed: `https://datahub.noxiaohao.com/mcp` (`shared/bitget-signal.js`) — BTC residual, Nasdaq proxy, event class.

If a feed is unreachable, fetchers return `{ ok:false, tag:'source_failed' }`. Demo continuity may use clearly labelled `assumed` placeholders — **never** labelled `observed`.

## Demo script for judges

1. Open the desk — banner visible: “Human decides. This desk does not trade.”
2. Leave the NVDA weekend thesis prefilled; notional 5000; **Run desk**.
3. Show frozen inputs with assumption tags; status chip; THIS THESIS vs COUNTER-THESIS.
4. Point at channel stacks, decay chart, stress first-to-die, factor verdict, receipt copy.
5. Move sliders — band / first-to-die update locally with no model call.
6. Optional: with writer key, show sanitized briefing; without key, numbers still load.
7. `npm run test:sanitize` — `"BUY NVDA"` loses `BUY`.

## Hard rules

1. Never place orders. No Agent Hub write calls.
2. Never print BUY / SELL / LONG / SHORT (sanitizer strips them).
3. US stocks + rToken focus: NVDA, TSLA, AAPL.
4. The writer drafts only; freeze numbers are ground truth.
5. No secrets in git (`.env` gitignored).
