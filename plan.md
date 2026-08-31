# Upstox API — what it replaces, and what it does not

Written 2026-08-31, against the stack described in [docs/02-data-sources.md](docs/02-data-sources.md). Every Upstox figure here is either quoted from the developer docs or measured directly from the published instrument masters on the date above.

## The one thing that decides everything

An Upstox OAuth access token **expires at 3:30 AM IST the next day, always**, and the standard flow has no refresh token. Every `pg_cron` schedule in [supabase/migrations/0009_metric_cron.sql](supabase/migrations/0009_metric_cron.sql) would break every morning until someone logged in by hand.

The **Analytics Token** is the only reason this is worth doing: 1-year validity, read-only, generated from the Developer Apps page with no redirect, one per account, and it covers Market Quote, Historical Data, Fundamentals, Market Information and the Websocket feed **without a static IP requirement**.

> **If the Analytics Token cannot be generated on this account, stop reading — none of the server-side moves below are viable, and the current anonymous stack stays exactly as it is.**

---

## What was measured

Downloaded 2026-08-31 from `assets.upstox.com/market-quote/instruments/exchange/`:

| File | Rows | Findings |
|---|---|---|
| `NSE.json.gz` | 73,896 total · **9,700 `NSE_EQ`** | `instrument_type` **is the NSE series**: EQ 2,650 · BE 235 · BZ 38 · **SM 448 · ST 116 · SZ 2** · plus SG/GS/TB/N\* debt. `security_type: "SME"` on **555 rows**. **9,700/9,700 carry an ISIN.** |
| `BSE.json.gz` | 26,018 total · **12,889 `BSE_EQ`** | `instrument_type` is the BSE group (A 701 · B 1,835 · X 1,168 · XT 514 · M 387 · T 219 · MT 132 · Z 93 · P 61 · E 38 = **5,148**, against BSE's own 5,099 active equity count; F 6,562 and G 1,131 are debt/govt noise). **12,889/12,889 carry an ISIN.** `exchange_token` is the BSE scrip code. |

Record shape (RELIANCE, NSE):

```json
{ "segment": "NSE_EQ", "name": "RELIANCE INDUSTRIES LTD", "exchange": "NSE",
  "isin": "INE002A01018", "instrument_type": "EQ",
  "instrument_key": "NSE_EQ|INE002A01018", "lot_size": 1,
  "freeze_quantity": 100000, "exchange_token": "2885", "tick_size": 10,
  "trading_symbol": "RELIANCE", "short_name": "Reliance Industries",
  "qty_multiplier": 1, "security_type": "NORMAL", "cas_eligible": true }
```

`EMKAYTOOLS` — the exact SME symbol [_shared/upstream.ts:335](supabase/functions/_shared/upstream.ts#L335) cites as Yahoo showing ₹883.95 against an actual close of ₹94.20 — **is present**, as `NSE_EQ|INE332S01011`, type `SM`, `security_type: SME`.

From the developer docs: full market quote **500 keys/request** (error `UDAPI100042` above it); LTP and OHLC v3 documented at 500; historical candles — `days` since **Jan 2000** (one decade per request), `months` since Jan 2000 (no limit), `minutes` since **Jan 2022**; rate limits **50/sec · 500/min · 2000/30min** per API per user on the standard tier; websocket v3 **5,000 instruments in LTPC / 2,000 in full**, 2 connections, protobuf; `/fundamentals/:isin/key-ratios` returns **P/E, P/B, ROA, ROE, ROCE, EV/EBITDA** with sector benchmarks.

---

## Scorecard

| # | What the app needs | Today | Upstox | Verdict |
|---|---|---|---|---|
| 1 | Master list | NSE `EQUITY_L.csv` + `SME_EQUITY_L.csv` + BSE `ListofScripData` | `NSE.json.gz` + `BSE.json.gz`, 6 AM daily | **Both** — add, don't replace |
| 2 | Live prices | Yahoo `/v7` + cookie/crumb, 200/req | `/v3/market-quote/ltp`, 500/req | **Upstox wins** |
| 3 | SME/Emerge prices | NSE bhavcopy EOD walk-back | Live, same endpoint as everything else | **Upstox wins outright** |
| 4 | Market cap | Yahoo `/v7` `marketCap`, free with the price | Not in the quote; profile endpoint is per-ISIN and ambiguous | **Keep Yahoo** |
| 5 | ROCE | screener.in scrape, 1.2s/row | `/fundamentals/:isin/key-ratios` | **Upstox wins** |
| 6 | Whole-universe monthly closes | Yahoo `spark`, 20/req, 262 requests | 1 instrument/request, no batch | **Keep Yahoo — decisively** |
| 7 | Chart / confirm-pass bars | Yahoo `chart`, 1/req, unauthenticated | `/v3/historical-candle`, adjusted, back to 2000 | **Upstox for correctness, Yahoo as fallback** |
| 8 | F&O + cap band | NSE `fo_mktlots.csv` + index CSVs | `NSE_FO` segment covers F&O; no index lists | **Partial** |
| 9 | Session calendar | Walk back 12 days looking for a bhavcopy | Holidays / Timings / Status APIs | **Upstox wins (small)** |
| 10 | Intraday (ORB leg) | Not implemented — stated impossible | 1-min candles since Jan 2022 | **Upstox unlocks it** |
| 11 | Streaming | 5-min cron | Websocket, 5,000 instruments LTPC | **New capability, out of scope** |

---

## 1. Master list — add, do not replace

Upstox's masters are easier to consume by every measure: one gzipped JSON per exchange, no `Referer` games, no WAF that *hangs* on a header combination ([docs/07-gotchas.md](docs/07-gotchas.md) §1), no 1.8 MB BSE payload behind an API that requires four empty query parameters. And `instrument_type` carries the NSE series and the BSE group directly — the same column `mergeListings()` writes today.

**But `EQUITY_L.csv` carries four fields Upstox does not publish at all:** listing date, face value, paid-up value, market lot. Those are real columns in `securities` and real filters in the UI. Upstox's `lot_size` is 1 for every cash equity and is not the same thing.

Upstox's BSE file is not noise-free either: 12,889 `BSE_EQ` rows, of which 6,562 are group F (debt) and 1,131 group G (government). That is exactly the "extract the real companies out of a broker dump" problem that got the Zerodha and Dhan masters rejected in [docs/02-data-sources.md](docs/02-data-sources.md) §2.7 — Upstox is simply better at it, not free of it.

**So:**

- Keep `mergeListings()` in [src/lib/listings.ts](src/lib/listings.ts) and [supabase/functions/_shared/upstream.ts](supabase/functions/_shared/upstream.ts) as they are.
- Add one `instrument_key` column to `securities`. It looks derivable — `NSE_EQ|<isin>`, `BSE_EQ|<isin>` — but take it **from the master file**, so an instrument Upstox does not carry is visibly absent rather than silently 404-ing on every later call.
- Use the Upstox master as a **second delisting oracle** alongside `planDelistings()` ([sync-securities/index.ts:44](supabase/functions/sync-securities/index.ts#L44)). It refreshes at 6 AM daily and lists only tradable instruments, which is a cleaner signal than "absent from a CSV that might have been truncated".

## 2. Prices — the clear win

Today: 27 requests at 200 tickers, 2.8s, **5,088 of 5,229 rows priced** — and the price of admission is an undocumented cookie+crumb handshake that 401s without warning and is implemented twice ([worker/yahooQuote.ts](worker/yahooQuote.ts) and [_shared/yahoo.ts:54](supabase/functions/_shared/yahoo.ts#L54)).

Upstox: **11 requests at 500 keys**, documented, rate-limited on published numbers, no credential dance. It quotes every instrument on the master — every thin BSE scrip and every SME row included, which is most of the 141 Yahoo still leaves unpriced.

**What is lost: `marketCap`.** Yahoo returns it in the same response ([sync-quotes/index.ts:117](supabase/functions/sync-quotes/index.ts#L117)), which is the only reason `market_cap_cr` is currently free. Upstox's quote does not carry it.

**Recommended shape:** Upstox `/v3/market-quote/ltp` becomes the price source (`last_price`, `cp` as previous close, `volume`); the Yahoo `/v7` pass survives as a **market-cap-only pass**, code unchanged, run less often. Market cap moves with the price, but the band it feeds is two orders of magnitude wide — daily is plenty, and [src/lib/marketCap.ts:52](src/lib/marketCap.ts#L52) already says so in as many words.

## 3. SME — delete the workaround

`fetchNseBhavcopy()` ([_shared/upstream.ts:379](supabase/functions/_shared/upstream.ts#L379)) exists solely because Yahoo's Emerge data froze in July 2024. It walks back up to 12 days looking for a session file, downloads ~390 KB per session, needs five sessions to price 539 of 565 rows, and every one of them lands as an end-of-day close stamped up to four days stale.

Upstox carries all 555 SME instruments as ordinary `NSE_EQ` rows — measured above, `EMKAYTOOLS` included — and quotes them live intraday through the same endpoint as everything else.

**The whole overlay goes:** `fetchNseBhavcopy`, `BhavQuote`, `bhavcopyUrl`, the `SME_SERIES` block in `sync-quotes`, and the "an Emerge row is exchange-sourced or it is blank" invariant that only exists because the workaround needed one.

## 4. Market cap — keep Yahoo

`/fundamentals/:isin/profile` returns a market cap, but the documentation describes it as a **sector** market cap and lists no shares outstanding. Even if it turns out to be per-company, it is one request per ISIN — 5,229 requests against Yahoo's 27 that arrive free with the price.

**Verify once. Keep Yahoo unless the profile figure is per-company *and* agrees with Yahoo on a sample.**

## 5. ROCE — the second clear win

[sync-fundamentals/index.ts](supabase/functions/sync-fundamentals/index.ts) is the slowest and most fragile thing in the repo, and its own header says so: 1.2s minimum between requests, 90 rows per invocation, **~2.5 days for a first full pass**, parsing an HTML ratio strip with no contract — where `Number('')` returning `0` once turned "files no consolidated statements" into a definite ROCE *fail*.

`/fundamentals/:isin/key-ratios` returns ROCE as JSON keyed by ISIN, which `securities` already stores as its merge key. At the documented 500/min the full universe is roughly **90 minutes instead of two and a half days**, and P/E, P/B, ROA, ROE and EV/EBITDA come along for free.

**One caution to settle before the screens switch over.** The screens are calibrated against Chartink, and `/consolidated/` was chosen deliberately: Reliance reads 7.78% standalone against 10.3% consolidated — opposite sides of the `> 10` leg. Upstox does not document which basis its ROCE uses. **A/B 30 companies against screener.in before [src/lib/screens.ts](src/lib/screens.ts) reads the new column.** Until then, write Upstox's figure to a new column and leave the screen leg on the old one.

screener.in also supplies `fundamentals_url`, the link the drawer renders. Keep the scrape for that alone, or drop the link.

## 6. Monthly closes — Upstox is worse, keep spark

The finding that matters most, because it is the one that looks backwards.

**Upstox historical candles are one instrument per request. There is no batch form.** The scan pass and `sync-technicals` both need ten years of monthly closes for the whole universe:

| | Requests | Wall clock |
|---|---|---|
| Yahoo `spark`, 20/request | 262 | ~40s |
| Upstox, 1/request | 5,229 | ~78 min (bound by 2000/30min) |

**Keep `fetchYahooSparkBars()` ([src/lib/yahooCandles.ts:207](src/lib/yahooCandles.ts#L207)) and `fetchMonthlyCloses()` ([_shared/yahoo.ts:191](supabase/functions/_shared/yahoo.ts#L191)) exactly as they are.**

There is a targeted exception worth taking. `CoarseTechnicals.density` ([src/lib/technicals.ts:381](src/lib/technicals.ts#L381)) documents that spark **silently omits months** for thin scrips — AHLWEST returns 76 monthly bars where `chart` gives 120 — and an RSI computed on the survivors diverges by up to 20 points. Those rows already route to the confirm pass. **Point the confirm pass at Upstox instead of Yahoo `chart`:** same request count, better bars. Cheap, and it closes a known correctness hole rather than a performance one.

## 7. History — Upstox for correctness

The strongest technical argument for Upstox anywhere in this repo is already written in [src/lib/technicals.ts:161](src/lib/technicals.ts#L161):

> It does not catch the other shape of bad history — a split Yahoo never applied, where a whole stretch of bars is uniformly scaled and each one is internally consistent. Those rows (`UEL`, `CLCIND`, `IVZINGOLD`) still read far below their true position and are **why this screen is not a drop-in replacement for Chartink's**.

`SPIKE_RATIO` is a heuristic patching a vendor defect. Upstox retroactively adjusts historical prices for corporate actions (community-confirmed; **not formally documented — verify on those three symbols first**) and publishes a Corporate Actions API to cross-check against. Daily bars reach back to **January 2000** against Yahoo's ten years, which also shrinks the "Yahoo's history is shorter than the exchange's" bucket that `DECADE_MONTHS` currently pushes into *unjudged*.

**Where Yahoo still wins: it needs no token.** `fetchYahooCandles` is called straight from the browser through the existing same-origin proxy in both modes, and the drawer works with zero setup. **An Upstox token must never reach the browser bundle** — every Upstox call has to be proxied by the Worker or an Edge Function holding the secret.

**Verdict:** Upstox for the confirm pass and the drawer chart, proxied server-side; Yahoo kept as fallback and as what runs when no token is configured — the same "degrade, never fail" posture `fetchMarketCaps` already takes with a refused credential.

## 8. Classification — partial

`NSE_FO` in the master gives every F&O underlying directly, retiring the sectioned-CSV parsing in [src/lib/classification.ts:52](src/lib/classification.ts#L52) — the file where a repeated header row parses as a security literally named "Symbol".

Cap bands come from the Nifty 50 / Next 50 / Midcap 150 / Smallcap 250 constituent lists. **Upstox publishes no index constituents. Those NSE CSVs stay.** And since they stay, so do the proxy entry and the header rewrite that serve them — the saving is one file out of four.

## 9. Session calendar — small, real

Market Holidays / Timings / Status replace two pieces of guesswork: the 12-day bhavcopy walk-back (which dies with §3 anyway) and `isMarketOpen()` in [src/lib/format.ts](src/lib/format.ts), which cannot know about an exchange holiday. One call, cached for a day.

## 10. Intraday — the ORB leg becomes possible

[src/lib/signals.ts:17](src/lib/signals.ts#L17) states plainly that the ORB half of `SVMKR_UT_HMA_ORB 6 1 31 5 1010-1015` is unimplemented because "Yahoo carries intraday bars for 60 days at one request per symbol per timeframe — a table of 2,400 rows cannot pay for it".

Upstox serves 1-minute candles back to January 2022. The per-request cost is the same, so this is still not viable for the whole table — but it **is** viable for a watchlist, or for the handful of rows a screen returns. That moves the feature from impossible to scoped.

## 11. Websocket — noted, not planned

5,000 instruments in LTPC mode over 2 connections, protobuf-encoded. It would turn the 5-minute cron into a live tape. It also needs a persistent relay (a Durable Object, or a long-lived process) because the browser cannot hold the token — a new piece of infrastructure this app does not have. **Real, and out of scope.**

---

## Risks that argue for the current stack

1. **Single point of failure.** Today NSE, BSE, Yahoo and screener.in fail independently, and every sync is written to survive losing any one of them. Routing prices, history and fundamentals through one token makes a single revocation an outage across all three.
2. **It is a personal account.** The current stack uses public, unauthenticated endpoints and belongs to nobody. An Upstox token is tied to your demat account, and its rate limits are shared with anything else you run against it.
3. **Terms of service.** Broker market data is licensed to the account holder. This app is deployable publicly on Cloudflare; serving other users' page loads out of one personal token is a licensing question the anonymous stack never raised. **For a public deployment this is the strongest reason to keep Yahoo on the front end** and use Upstox only for server-side ingestion into your own database.
4. **Zero-setup mode dies.** `activeSource` picks `directSource` when Supabase is unconfigured, and the whole app runs from `npm run dev` with no credentials ([docs/01-overview.md](docs/01-overview.md), "The two-mode design"). Every Upstox path has to be optional, or that property is gone.

**Design rule for all of it:** an Upstox failure must degrade to the existing path, never to an error — the contract `fetchMarketCaps` already honours, where "a refused credential, a blocked endpoint or a dead ticker all come back as an absent entry".

---

## Phased adoption

**Phase 0 — verify** (one throwaway script, ~1 hour). Generate the Analytics Token, then answer with numbers:

- Does `/fundamentals/:isin/profile` return a **company** market cap, and does it agree with Yahoo on 20 names?
- Do `UEL`, `CLCIND` and `IVZINGOLD` come back split-adjusted from `/v3/historical-candle`?
- Does Upstox ROCE agree with screener.in across 30 companies spanning large/mid/micro, including one holding company?
- Do 20 SME symbols quote live, and do they match the bhavcopy close?
- What is the real per-request cap on `/v3/market-quote/ltp`, and what does the rate limiter actually do at 500 keys × 11 requests?

**Phase 1 — prices.** `sync-quotes` reads `instrument_key` and prices via Upstox; the Yahoo `/v7` pass stays for `market_cap_cr` only; the bhavcopy SME overlay is deleted. *Expected: 5,229/5,229 priced, live SME, no crumb on the hot path.*

**Phase 2 — ROCE.** `sync-fundamentals` calls `/fundamentals/:isin/key-ratios` into a new column; the screens keep reading the screener.in column until the A/B says otherwise. *Expected: a full pass in ~90 minutes instead of 2.5 days.*

**Phase 3 — instrument keys.** Add `instrument_key` to `securities`, populated by `sync-securities` from the Upstox masters; use master-absence as a second delisting signal.

**Phase 4 — history.** Confirm pass and drawer chart on Upstox candles behind a Worker route, Yahoo as fallback. Revisit `SPIKE_RATIO` and `DECADE_MONTHS` once the bars are adjusted and reach back to 2000.

**Phase 5 — optional.** Intraday ORB for watchlist rows. Websocket if a relay ever becomes worth building.

## Verification

- `npm run typecheck` and `npm run build` clean at every phase.
- `scripts/check-metrics.mjs`, `check-listings.mjs`, `check-signals.mjs` and `check-unknown-tickers.mjs` pass before and after — these are the existing measured checks and they are the regression suite.
- Row counts before and after each phase: total priced, SME priced, rows with a ROCE, rows with a market cap. A phase that lowers any of them is a regression no matter how much faster it is.
- Kill the token deliberately and confirm every sync still completes on the Yahoo path.
