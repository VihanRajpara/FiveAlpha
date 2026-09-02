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

## Phase 0 results — measured 2026-08-31

`npm run check:upstox` ([scripts/upstox-check.mjs](scripts/upstox-check.mjs)) ran the five claims below against a live Analytics Token. Four held; one changed the recommendation.

| Claim | Verdict | Measured |
|---|---|---|
| 500 keys/request, 11 requests for the universe | **PASS** | 500 → HTTP 200, **501 → HTTP 400**. 11 calls, 5,500 instruments, **0.8s** (Yahoo `/v7`: 27 calls, 2.8s) |
| SME quoted live | **PASS** | **20/20** priced. `EMKAYTOOLS` ₹95.00 against Yahoo's ₹883.95 stamped **2024-07-23** — the repo cites an actual close of ₹94.20. Yahoo carried a pre-2025 timestamp on 10 of the 20 |
| ROCE usable for the `> 10` leg | **PASS** | **0/14** rows flip the leg. RELIANCE 10.39 vs screener.in's 10.30 → **consolidated basis confirmed**. But absolute values drift up to 9pp (VEDL 25.21 vs 16.10) |
| Profile market cap is per company | **PASS** | It is — despite being named `sector_market_cap_inr`. TCS 848,080 Cr / INFY 464,100 Cr / RELIANCE 1,738,119 Cr, all **within 0.6–3.2%** of Yahoo |
| History usable for the ten-year-high leg | **PARTIAL** | **Upstox history is keyed by ISIN and restarts at a corporate action.** `UEL` 29 bars from 2024-04 and `CLCIND` 8 bars from 2026-01, against Yahoo's 121 for both. Deeper where the ISIN is stable: RELIANCE returns 240 monthly bars over a 20y window |

The last row is the one that moved. §7 below is rewritten around it.

---

From the developer docs: full market quote **500 keys/request** (error `UDAPI100042` above it); LTP and OHLC v3 documented at 500; historical candles — `days` since **Jan 2000** (one decade per request), `months` since Jan 2000 (no limit), `minutes` since **Jan 2022**; rate limits **50/sec · 500/min · 2000/30min** per API per user on the standard tier; websocket v3 **5,000 instruments in LTPC / 2,000 in full**, 2 connections, protobuf; `/fundamentals/:isin/key-ratios` returns **P/E, P/B, ROA, ROE, ROCE, EV/EBITDA** with sector benchmarks.

---

## Scorecard

| # | What the app needs | Today | Upstox | Verdict |
|---|---|---|---|---|
| 1 | Master list | NSE `EQUITY_L.csv` + `SME_EQUITY_L.csv` + BSE `ListofScripData` | `NSE.json.gz` + `BSE.json.gz`, 6 AM daily | **Both** — add, don't replace |
| 2 | Live prices | Yahoo `/v7` + cookie/crumb, 200/req | `/v3/market-quote/ltp`, 500/req | **Upstox wins** |
| 3 | SME/Emerge prices | NSE bhavcopy EOD walk-back | Live, same endpoint as everything else | **Upstox wins outright** |
| 4 | Market cap | Yahoo `/v7` `marketCap`, free with the price | Per-company after all, but 1 request per ISIN | **Keep Yahoo** (budget, not quality) |
| 5 | ROCE | screener.in scrape, 1.2s/row | `/fundamentals/:isin/key-ratios` | **Upstox wins** |
| 6 | Whole-universe monthly closes | Yahoo `spark`, 20/req, 262 requests | 1 instrument/request, no batch | **Keep Yahoo — decisively** |
| 7 | Chart / confirm-pass bars | Yahoo `chart`, 1/req, unauthenticated | Adjusted and twice as deep — but ISIN-keyed, so it truncates at corporate actions | **Both, with a fallback** |
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

Upstox, **measured**: 500 keys accepted, 501 rejected with a 400, and **11 requests priced 5,500 instruments in 0.8 seconds** — against Yahoo's 27 requests and 2.8s. Documented, rate-limited on published numbers, no credential dance. It quotes every instrument on the master, every thin BSE scrip and every SME row included, which is most of the 141 Yahoo still leaves unpriced.

**What is lost: `marketCap`.** Yahoo returns it in the same response ([sync-quotes/index.ts:117](supabase/functions/sync-quotes/index.ts#L117)), which is the only reason `market_cap_cr` is currently free. Upstox's quote does not carry it.

**Recommended shape:** Upstox `/v3/market-quote/ltp` becomes the price source (`last_price`, `cp` as previous close, `volume`); the Yahoo `/v7` pass survives as a **market-cap-only pass**, code unchanged, run less often. Market cap moves with the price, but the band it feeds is two orders of magnitude wide — daily is plenty, and [src/lib/marketCap.ts:52](src/lib/marketCap.ts#L52) already says so in as many words.

## 3. SME — delete the workaround

`fetchNseBhavcopy()` ([_shared/upstream.ts:379](supabase/functions/_shared/upstream.ts#L379)) exists solely because Yahoo's Emerge data froze in July 2024. It walks back up to 12 days looking for a session file, downloads ~390 KB per session, needs five sessions to price 539 of 565 rows, and every one of them lands as an end-of-day close stamped up to four days stale.

Upstox carries all 555 SME instruments as ordinary `NSE_EQ` rows — measured above, `EMKAYTOOLS` included — and quotes them live intraday through the same endpoint as everything else.

**The whole overlay goes:** `fetchNseBhavcopy`, `BhavQuote`, `bhavcopyUrl`, the `SME_SERIES` block in `sync-quotes`, and the "an Emerge row is exchange-sourced or it is blank" invariant that only exists because the workaround needed one.

## 4. Market cap — keep Yahoo, but for a different reason than expected

**Measured: the figure *is* per company.** Despite being named `sector_market_cap_inr`, `/v2/fundamentals/:isin/profile` returns the company's own cap in a `{value, unit, formatted}` object — TCS 848,080 Cr, INFY 464,100 Cr, RELIANCE 1,738,119 Cr, THYROCARE 9,311 Cr, every one within 0.6–3.2% of Yahoo's figure for the same company. The documentation's "sector market cap" wording is simply wrong.

So the original objection (it might be a sector aggregate) is dead. **The cost objection is not:** it is one request per ISIN. The whole universe is 5,229 requests against the 27 Yahoo answers for free alongside the price it is already fetching.

**Verdict unchanged — keep the Yahoo `/v7` market-cap pass** — but it is now a choice about request budget rather than about data quality, and if the Yahoo crumb ever dies for good, Upstox is a working replacement at ~90 minutes a pass rather than no replacement at all.

> Watch the parse. `String({}).replace(/[^0-9.]/g, '')` is `''`, and `Number('')` is **0** — the identical trap [scripts/check-metrics.mjs](scripts/check-metrics.mjs) already guards for on screener.in's empty ratio spans. It made the first run of the check report a definite "sector aggregate" that was not there.

## 5. ROCE — the second clear win

[sync-fundamentals/index.ts](supabase/functions/sync-fundamentals/index.ts) is the slowest and most fragile thing in the repo, and its own header says so: 1.2s minimum between requests, 90 rows per invocation, **~2.5 days for a first full pass**, parsing an HTML ratio strip with no contract — where `Number('')` returning `0` once turned "files no consolidated statements" into a definite ROCE *fail*.

`/fundamentals/:isin/key-ratios` returns ROCE as JSON keyed by ISIN, which `securities` already stores as its merge key. At the documented 500/min the full universe is roughly **90 minutes instead of two and a half days**, and P/E, P/B, ROA, ROE and EV/EBITDA come along for free.

**The basis question is settled — measured, not assumed.** The screens are calibrated against Chartink, and `/consolidated/` was chosen deliberately: Reliance reads 7.78% standalone against 10.3% consolidated, opposite sides of the `> 10` leg. Upstox returns **10.39%** for Reliance, so it is the consolidated basis.

Across 14 companies weighted towards the threshold band (NTPC 8.02 vs 8.92, POWERGRID 8.81 vs 9.10, GAIL 8.97 vs 9.67, TATASTEEL 11.35 vs 12.50, ONGC 14.72 vs 14.20), **0 of 14 landed on opposite sides of `> 10`**. That is the only agreement the screens need.

**It is not a general replacement for the number, though.** Absolute values drift — VEDL reads 25.21 against screener.in's 16.10, TCS 55.21 against 63.00 — so the two sources are computing over different periods. Fine for a threshold leg, wrong for a displayed figure anyone compares against screener.in. Write it to its own column, point the screen leg at it, and keep screener.in's value as what the drawer shows.

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

`SPIKE_RATIO` is a heuristic patching a vendor defect. Upstox's prices *are* adjusted — but measuring it turned up a second problem that outweighs the first.

**Upstox history is keyed by ISIN, and a corporate action that issues a new ISIN restarts it.** Measured on the three symbols named above:

| symbol | Upstox | Yahoo |
|---|---|---|
| `UEL` | **29 monthly bars**, from 2024-04 | 121 bars |
| `CLCIND` | **8 monthly bars**, from 2026-01 | 121 bars |
| `IVZINGOLD` | 120 bars — decade high 156.00 | 120 bars — decade high 15,599.80 (**exactly 100×**) |
| `RELIANCE` | 120 bars over a 10y window, **240 over a 20y window** | 121 bars, and 10y is all Yahoo gives |

Read together: where the ISIN is stable Upstox is **strictly better** — twice the depth, and `IVZINGOLD` shows the adjusted series against Yahoo's 100×-wrong one, which is exactly the defect §7 set out to fix. But `UEL` and `CLCIND` are the *very rows* this section wanted to rescue, and Upstox has less history for them than Yahoo does, not more.

`DECADE_MONTHS` needs 120 months before a ten-year high exists at all, so those rows come back **unjudged** — the same outcome as today, reached by a different route. Upstox alone does not fix the split problem; it relocates it onto whichever companies have restructured.

**So the confirm pass takes both**: ask Upstox first, and fall back to Yahoo when the Upstox series is shorter than the window the leg needs. That is more code than "point it at Upstox", and it is what the measurement actually supports.

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

**Phase 0 — verify. ✅ Done 2026-08-31.** `npm run check:upstox` — see the results table at the top. Four claims held, one (history depth) changed §7. Re-run it whenever the token is rotated; it is also the smoke test that the token still works.

**Phases 1 + 2 — prices, market cap and ROCE. ✅ Built 2026-08-31, Upstox-only.**

The fallbacks are gone, by explicit decision: no Yahoo quote path, no bhavcopy walk-back, no screener.in scrape. [sync-quotes](supabase/functions/sync-quotes/index.ts) prices from Upstox alone; [sync-fundamentals](supabase/functions/sync-fundamentals/index.ts) fills ROCE **and** market cap per ISIN. Without `UPSTOX_ACCESS_TOKEN` both return 503 and write nothing, rather than silently degrading to a worse source.

Deleted: `fetchNseBhavcopy`/`BhavQuote`/`bhavcopyUrl`, the whole Yahoo cookie+crumb quote path in `_shared/yahoo.ts`, `fetchYahooQuoteBatch`, screener.in scraping and its `parseTopRatios`, and the duplicate copies of all of it in `scripts/seed.mjs`. `_shared/yahoo.ts` survives at 123 lines holding only spark + Wilder RSI, which §6 keeps.

Measured against the live `securities` table — 5,831 rows, 565 of them SME:

| | Result |
|---|---|
| Priced by Upstox | **5,680 / 5,831** in **1.0s**, 12 requests, 0 failed |
| SME priced live | **560 / 565** — against the bhavcopy's 539 at end-of-day, up to four days stale |
| Vendor timestamp present | **5,680 / 5,680** |
| Previous close derivable | **5,680 / 5,680** |
| Rows with no usable ISIN | 3 — they fall through to Yahoo, as designed |

The ~151 Upstox does not carry are BSE debt scrips (`08ADD`, `11ADR`, …) that were never really equities. They now stay unpriced, which is the honest answer for a row that is not a company.

Fundamentals, sampled over real equities: **12/12 returned both a ROCE and a market cap**, SME rows included (`AAKAAR` 15.03% / ₹91.56 Cr) — neither of which the old stack could supply for Emerge at all. Negative ROCE parses (`21STCENMGM` −72.48).

> **One bug caught in the new code, worth recording.** Upstox answers `market_cap = 0` for every BSE debt scrip. The first guard accepted it, which would have stored ~150 companies as *worth nothing* — passing a `>= 0` cap band and sorting to the top of a smallest-first list. It is the `Number('') === 0` trap in a different costume, the same one [check-metrics.mjs](scripts/check-metrics.mjs) already existed to catch on screener.in. `toMarketCapCr()` is now a separate function precisely so it could be pinned by assertions.

**No migration was needed.** `instrument_key` is `SEGMENT|ISIN` for 9,700/9,700 rows of the NSE master, so [toInstrumentKey()](supabase/functions/_shared/upstox.ts) derives it from the `isin` column `securities` already stores — no new column, and no 35 MB instrument dump per invocation. Phase 3 below is therefore optional rather than a prerequisite.

**To activate:** `supabase secrets set UPSTOX_ACCESS_TOKEN=...` then redeploy the function. Without the secret the Upstox stage does nothing and the behaviour is exactly what it was before.

**Phase 3 — instrument keys.** Optional, not a prerequisite — `toInstrumentKey()` derives the key from the stored ISIN. Worth doing only if the Upstox master becomes wanted as a second delisting oracle.

**Phase 4 — history.** Confirm pass and drawer chart on Upstox candles behind a Worker route, **falling back to Yahoo whenever the Upstox series is shorter than the window the leg needs** — measured, that is not a rare edge case. `SPIKE_RATIO` stays until the fallback is in and the two sources have been reconciled per row.

**Phase 5 — optional.** Intraday ORB for watchlist rows. Websocket if a relay ever becomes worth building.

## Verification

- `npm run typecheck` and `npm run build` clean at every phase.
- `scripts/check-metrics.mjs`, `check-listings.mjs`, `check-signals.mjs` and `check-unknown-tickers.mjs` pass before and after — these are the existing measured checks and they are the regression suite.
- Row counts before and after each phase: total priced, SME priced, rows with a ROCE, rows with a market cap. A phase that lowers any of them is a regression no matter how much faster it is.
- Kill the token deliberately and confirm every sync still completes on the Yahoo path.
