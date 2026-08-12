[← Gotchas](07-gotchas.md) · [Docs index](README.md)

# 8. Screens

A screen takes a Chartink scan clause and runs it over the rows the filters currently select. There is one so far — **Near all-time-high breakout**, from [this Chartink screen](https://chartink.com/screener/all-time-high-breakout-9032071) — and the machinery around it is built so a second is a data change rather than a code change.

## 8.1 The clause

Lifted verbatim from the screener page (it is in the page's `atlas_query` field, not in the visible HTML):

```
( {cash} (
    daily close  >  yearly max( 10 , yearly high ) * 0.75
and daily close <=  yearly max( 10 , yearly high ) * 1
and yearly return on capital employed percentage > 10
and market cap >= 500  and  market cap <= 50000
and monthly rsi( 14 ) >= 65
) )
```

In words: **a quality mid- or small-cap pressed up against a decade high with monthly momentum behind it.**

| Chartink fragment | Here | Source |
|---|---|---|
| `daily close > yearly max( 10 , yearly high ) * 0.75` | close is within 25% of the 10-year high | Yahoo 10y/1mo bars |
| `daily close <= yearly max( 10 , yearly high ) * 1` | close is not above that high | same request |
| `monthly rsi( 14 ) >= 65` | Wilder RSI(14) on monthly closes | same request |
| `market cap >= 500 and <= 50000` | ₹500–50,000 Cr | screener.in scrape |
| `yearly return on capital employed percentage > 10` | ROCE > 10% | screener.in scrape |

`yearly max( 10 , yearly high )` is the highest yearly high over ten years — a ten-year high, which is what "all-time" means in practice for most of this list. The max of the monthly highs is the same number, since a yearly high is itself the max of its months; that identity is what lets one monthly request answer three legs.

The clause above is not a paraphrase — it is the `atlas_query` field on the screener page, checked verbatim against the code in [screens.ts](../src/lib/screens.ts). Where this and Chartink disagree, it is never the clause; see [§8.7](#87-measured-against-chartink).

## 8.2 Where the pieces live

| File | Responsibility |
|---|---|
| [screens.ts](../src/lib/screens.ts) | The clause as a list of **legs**: the Chartink fragment, a label, a phase, and the predicate. `judge()` turns legs + metrics into a verdict. |
| [technicals.ts](../src/lib/technicals.ts) | 10-year high, latest close and monthly RSI(14). The exact figures from one `chart` request per symbol, and the cheap `spark` scan that bounds them twenty symbols at a time. Includes the Wilder RSI implementation. |
| [fundamentals.ts](../src/lib/fundamentals.ts) | Market cap and ROCE from a screener.in company page — see [§2.4](02-data-sources.md#24-fundamentals--screenerin-company-pages). |
| [useScreen.ts](../src/hooks/useScreen.ts) | The runner: three passes, bounded concurrency, progress, cancellation. |
| [ScreenBar.tsx](../src/components/ScreenBar.tsx) | Picker, run/stop, progress, counts, matches-only toggle, and the collapsed clause panel. |
| [StockTable.tsx](../src/components/StockTable.tsx) | The four screen columns, and the verdict treatment on rows. |

A leg carries its own Chartink fragment because the UI shows the clause it is running. A screen that silently drops 95% of the table has to be able to say exactly what it did.

## 8.3 Three passes, and why

Each pass is more expensive per row than the one before it, so each exists to shrink the input to the next.

```
rows ──► scan: spark 10y/1mo, 20 symbols/request ──► undecided ──► confirm: chart 10y/1mo, 1/request ──► survivors ──► fundamentals: screener.in
          (every row)                                 ~9%                                                  ~5%          (passers only, paced)
```

**The scan** reads ten years of monthly *closes* for twenty symbols in one request. That answers the RSI leg outright and bounds the ten-year high from below, which is enough to settle **~91%** of a universe without ever fetching its bars.

**The confirm pass** buys the real intra-month highs, one request per row, for what the bound could not decide.

**The fundamentals pass** scrapes only the rows still standing. An unknown cannot become a pass, so a scrape for one would buy nothing. It re-judges each row against *all* legs rather than combining two half-verdicts, so the final answer always comes from one pass over the whole clause.

### What the scan may conclude, and what it may not

`spark` carries closes and nothing else, so [`judgeScan()`](../src/lib/screens.ts) is written around two facts and refuses to go past them:

- **`closeHigh <= high10y`, always** — a month's close cannot exceed its own high. That proves a price is *far* from its high and proves nothing whatever about one that is near it. Feeding the bound to the `below-high` leg (`close <= high10y`) would fail precisely the shares sitting on a decade high, which is the entire population the screen exists to find. So the bound decides rejections only; it is attached to the metrics for display, flagged `approx`, and shown with a `≈`.
- **The RSI and the year count are exact only on a whole series.** For thinly traded shares `spark` *omits months altogether* where `chart` carries a close — AHLWEST returns 76 monthly bars against the chart's 120. An RSI over the survivors is not an approximation of the real one, it is a different series. `CoarseTechnicals.density` measures this, and below 1 both the RSI and the year count are withheld and the row goes to the confirm pass.

Measured over all 2,401 NSE symbols on 2026-08-12, against the exact pass run over the same universe:

| | |
|---|---|
| Decided by the scan alone | 2,181 (90.8%) |
| Sent to confirm | 220 (9.2%) |
| Rows the exact pass passes on its technical legs | 115 |
| …of those, reached the confirm pass | **115 (all)** |
| Rows the scan rejected that the exact pass would have kept | **0** |
| RSI gap where `density` is 1 (1,906 rows) | ≤ 8.6e-4 |
| RSI gap where it is not (200 rows) | up to 20.8 — withheld |

Both guards earn their place in that table: 19 symbols disagree about whether ten years of history exist, and every one of them is a gappy series that the `density` gate catches.

## 8.4 Verdicts

| Verdict | Meaning | In the table |
|---|---|---|
| `pass` | Every leg true | Green left edge; the row survives the matches-only cut |
| `fail` | At least one leg definitely false | Dimmed, with the deciding leg in the row tooltip |
| `unknown` | No leg false, but at least one unanswerable | Dimmed, counted separately as "unjudged" |

A definite failure beats an unknown, which is why `judge()` cannot return on the first non-true leg: a share listed three years ago whose price is 60% off its high is a *fail*, not an unjudged row, even though its RSI leg has no answer.

Unknowns are real and worth surfacing rather than hiding. Two causes dominate — too little price history for a 10-year high or a 14-period monthly RSI, and companies screener.in does not carry. A third is Yahoo data quality: `TANFACIND.NS` resolves to a record typed `MUTUALFUND` with no bars at all, so that row cannot be judged on price no matter how long it has been listed.

## 8.5 Cost, and why there is no cap

The request count *is* the wall-clock, so the whole optimisation is about issuing fewer requests rather than faster ones.

The per-symbol pass is **measured** at 6.9 rows/s through the dev proxy at six in flight — around 870 ms per request. The scan pass, measured the same way on the same day over 600 symbols, runs **19× that**; over the whole NSE list it was 38×. Batching twenty symbols per request is the entire difference.

| Universe | Before | Now |
|---|---|---|
| 500 | 85s | 41s |
| 2,400 (all NSE) | 7 min | 3 min |
| 5,229 (everything) | 15 min | 7 min |

The price work over the whole market fell from about a quarter of an hour to under two minutes. What is left is dominated by the **fundamentals pass**: screener.in is rate-limited to one request every 1.2s, and ~5% of a universe surviving to it is over five minutes of pure waiting on a whole-market run. That is now three quarters of the cost and the obvious next thing to attack — batching it behind the Worker's six-hour cache, or precomputing it, rather than paying the pacing gate per run.

The first version of this refused anything above 500 rows outright. That was wrong, and visibly so: the default view is all 5,229 companies, so the run button arrived disabled with its only explanation in a hover tooltip — a working screen that looked broken. **A limit nobody can click past is a dead end, not a guardrail.**

`LARGE_RUN` only decides whether the bar warns first, and is now 1,000 rather than 500 because 500 rows no longer takes long enough to be worth a warning. Above it the estimate appears next to the button before anything is fetched, the run reports progress and remaining time throughout, and stopping keeps everything already judged.

`estimateSeconds()` sums all three passes and is calibrated to the measurements above rather than to a guessed round trip. The guessed version assumed 300 ms and under-promised by nearly 3×.

Both fetch layers cache per tab, keyed by ticker and by URL, so a second run only pays for rows it has not seen — **a cached re-run of the same 180 symbols takes 0.18s**. Failures are dropped from the cache rather than remembered as verdicts, so re-running is also how you retry them.

### When Yahoo says no

One symbol in that 180 returned nothing. That rate does not hold across the whole list: Yahoo carries no history for many thinly traded BSE-only scrips. Those rows come back **unjudged**, so the scan counts them and the bar reports the total afterwards — a screen that quietly says "3,100 unjudged" without saying why is not reporting at all.

The scan pass changed what a miss means. A symbol it drops from a batch is one Yahoo carries nothing for anywhere: every one sampled also 404s on `chart`, so re-running is not a retry worth advertising. Judged rows are cached either way, which makes a second run near-instant rather than merely cheaper.

## 8.6 Measured

A 30-name mid-cap sample, run through the real modules against the live proxy. Kept as a record of the shape of the output; the RSI figures predate the corrections in [§8.7](#87-measured-against-chartink) and read 1–5 points low. A sample this size is also what let the universe-wide error there go unnoticed — every name in it is long-listed.

| Symbol | of 10Y high | RSI(M) | M.Cap ₹Cr | ROCE | Verdict |
|---|---|---|---|---|---|
| JBCHEPHARM | 95.4% | 77.7 | 38,677 | 25.4% | **pass** |
| ANANDRATHI | 97.9% | 79.4 | 35,423 | 59.2% | **pass** |
| NEULANDLAB | 94.5% | 71.5 | 28,517 | 26.5% | **pass** |
| SHAILY | 98.1% | 74.3 | 15,509 | 29.3% | **pass** |
| TDPOWERSYS | 89.6% | 72.4 | 19,331 | 34.0% | **pass** |
| APARINDS | 95.9% | 71.3 | 66,227 | 31.1% | fail — market cap |
| TITAN | 99.4% | 68.4 | 451,700 | 20.5% | fail — market cap |
| MCX | 79.3% | 71.4 | 70,041 | 71.4% | fail — market cap |
| KEI | 99.2% | 64.3 | — | — | fail — RSI |
| YESBANK | 5.6% | 53.5 | — | — | fail — 25% band |

The em dashes are the phase split working: those rows were never scraped.

## 8.7 Measured against Chartink

Chartink's scan endpoint takes an arbitrary `scan_clause`, so the screen can be checked against its own source rather than argued about. Running the clause's **technical legs alone** on 2026-08-12 gave 136 NSE names. Running the app's real modules over all 2,401 symbols in `EQUITY_L.csv`:

| | matches | agreed | spurious | missed |
|---|---|---|---|---|
| before the corrections below | 214 | 123 | 91 | 13 |
| after | **115** | **114** | **1** | 22 |

The screen was matching **three times** as many rows as Chartink, which is what a run over the full universe surfaces and a 30-name sample cannot.

End to end, both phases, same 2,401 symbols against Chartink's 64 full-clause matches:

| | matches | agreed | spurious | missed |
|---|---|---|---|---|
| before | 109 | — | — | — |
| after | **59** | 54 | 5 | 10 |

Two of the ten missed are `ARIHANT` and `DEEPINDS`, where Yahoo's history is too short to judge. The rest, and all five spurious, are boundary cases between two different fundamentals providers plus a few hours of price drift between the two runs.

### A row is a match when the whole clause says so

The price passes stored the verdict over the *technical* legs alone, so a row that had cleared price and momentum counted as a match before anything asked about market cap or ROCE. That is invisible while the fundamentals pass finishes and completely wrong when it does not — and it did not, because screener.in rate-limits (below). The run aborted and every row it never reached stayed a "match": **109 against Chartink's 64 on the same universe.**

They now judge against `def.legs` — the whole clause — and the fundamental legs return null on absent metrics, so those rows read **unjudged** until the fundamentals pass answers for them. The technical verdict is still computed, but only to decide which rows are worth a screener.in request.

### A ten-year high needs ten years

The dominant cause, and not a Yahoo problem: `yearly max( 10 , yearly high )` is a max over ten yearly bars, and a company that has not existed for ten years does not have ten of them. Chartink rejects those rows. Taking the max of whatever history exists instead quietly rewrites the leg as *"within 25% of the high since listing"* — which almost every recent IPO passes, because a share that has only ever traded in one bull market is always near its own high.

That was **91 of the 214**. Ninety of the ninety-one had under ten years of history, and Chartink rejected all ninety-one on this leg while agreeing with the RSI leg on eighty-four of them. `DECADE_YEARS` in [technicals.ts](../src/lib/technicals.ts) now returns a null ten-year high below eleven distinct calendar years, and the price legs read a missing high as **unjudged** rather than as a pass.

### Two things Yahoo's response gets wrong

**It reports the current month twice.** A `1mo` series ends with a monthly bar whose close is a day or two stale *and* a second bar dated today carrying the live price. 132 of the 133 symbols came back this way — it is the normal shape, not an edge case. That duplicate is an extra delta in the close series and Wilder RSI reads it as a real month's move, running the app 1–5 points under Chartink: ADOR 64.49 against 65.57, PANAMAPET 63.07 against 67.91. On a `>= 65` leg that is the difference between a match and a miss, and it was the single largest source of dropped rows. `collapseMonths()` in [technicals.ts](../src/lib/technicals.ts) merges the pair and reproduces Chartink to within **0.03 on every name checked**.

**Its Indian history carries bad ticks.** THYROCARE's October 2020 monthly bar reports a high of 1090 in a month that ranged 313–366; January 2020 reports 578 against a low of 180. Chartink has neither. This matters out of proportion to how often it happens, because the ten-year high is a `max` over 120 bars — one bogus high sets the level every later close is measured against. THYROCARE read as 59% of its ten-year high and failed the 25% band; against Chartink's high of 662 it is at 97%. `SPIKE_RATIO` discards a monthly high above twice its own bar's close, which across the 133 changed one verdict and reversed none.

### What still differs

- **Short Yahoo history on long-listed shares.** Most of the 22 missed rows. `DEEPINDS` and `ARIHANT` have traded for decades but Yahoo's series starts in 2021, so they now come back unjudged rather than matched. Preferring that to a wrong answer is the whole point of the third verdict.
- **Splits Yahoo never applied.** The other shape of bad history: a whole stretch of bars uniformly scaled, each internally consistent, so the spike filter cannot see it. `UEL`, `CLCIND`, `IVZINGOLD`, `SWANDEF` and `DIACABS` are all this. Catching them needs a discontinuity check across adjacent bars, not a within-bar one.
- **Universe.** Chartink's `{cash}` is 2,869 instruments. Here the universe is whatever the filters select — up to 5,229, including the ~2,800 BSE-only companies Yahoo largely has no history for, which come back unjudged. Screening **NSE only** is the like-for-like comparison.
- **Fundamentals provider.** ROCE and market cap come from screener.in; Chartink uses its own. Both are "latest annual, consolidated where available", but a company near the `> 10` boundary can land on opposite sides. This is now the largest remaining source of disagreement.
- **Timing of the fundamentals pass.** screener.in is rate-limited to one request every 1.2s, so the fundamentals pass over ~115 survivors takes a little over two minutes — see [§2.4](02-data-sources.md#24-fundamentals--screenerin-company-pages).
- **The `<= high` leg is near-tautological** in both, because the current bar's high already contains today's price. It is kept because it is in the clause, and because it is what makes this a run *up to* the high rather than a breakout above one.
- **Timing.** Chartink's snapshot lags the live quote by minutes, so borderline rows can differ intraday for no deeper reason than that.

## 8.8 Adding a screen

Append a `ScreenDef` to `SCREENS` in [screens.ts](../src/lib/screens.ts). If every leg reads from `ScreenMetrics`, nothing else changes — the picker, the runner, the columns and the clause panel are all driven from the definition. A leg needing a metric that isn't there yet is the only case that touches other files: add the field to `ScreenMetrics`, populate it in whichever phase can, and add a column if it deserves one.

---

[Docs index](README.md)
