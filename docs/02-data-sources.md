[← Overview](01-overview.md) · [Docs index](README.md) · Next: [Boot flow →](03-boot-flow.md)

# 2. Data sources

Every endpoint used, every endpoint rejected, with the evidence behind each decision. All results here were measured, not assumed.

## Summary

| Source | Auth | Status | Supplies |
|---|---|---|---|
| NSE `EQUITY_L.csv` | none (needs `Referer`) | ✅ used | The NSE master list (2,410 shares) |
| BSE `ListofScripData/w` | none (needs `Referer`) | ✅ used | The BSE master list (5,099 active equity scrips) |
| Yahoo `v8/finance/spark` | none | ✅ used | Closes only, 20 symbols/request. LTP + previous close for the table; 10y monthly for the screens' scan pass |
| Yahoo `v8/finance/chart` | none | ✅ used | OHLCV history, 1 symbol/request |
| screener.in company pages | none | ✅ used (screens only) | Market cap + ROCE, scraped, 1 company/request |
| Zerodha Kite `/instruments` | none | ⚪ viable fallback | 9,899 NSE instruments (noisy) |
| Dhan scrip master | none | ⚪ viable fallback | 26 MB, all segments |
| Yahoo `v7/finance/quote` | crumb required | ❌ rejected | 401 Unauthorized |
| Angel One scrip master | none | ❌ rejected | connection timeout |

---

## 2.1 The master lists — NSE `EQUITY_L.csv` + BSE scrip master

Each exchange publishes its own list, neither references the other, and most large companies are on both. The app fetches both and merges them on ISIN into **one row per company**.

### NSE — `EQUITY_L.csv`

The canonical, authoritative list of every share listed on the NSE cash market, published by the exchange itself.

```
https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv
```

### Required headers

NSE returns **403** without these. The `Referer` is the critical one.

```http
User-Agent:      Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ... Chrome/120.0.0.0 Safari/537.36
Referer:         https://www.nseindia.com/
Accept:          text/csv,application/csv,*/*
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate
```

> ⚠️ Sending *extra* browser headers alongside these can make the request hang indefinitely rather than fail. See [Gotchas §1](07-gotchas.md#1-nses-waf-hangs-on-browser-header-fingerprints). This is why the proxy replaces headers instead of merging them.

### Response

- **169,183 bytes** raw · **57,448 bytes** gzipped
- CRLF line endings, UTF-8
- **2,398 lines** = 1 header + **2,397 securities**
- Header names carry leading spaces (` SERIES`, ` ISIN NUMBER`, …) — they must be trimmed
- Company names containing commas are double-quoted, so a naive `split(',')` corrupts rows. This is why [csv.ts](../src/lib/csv.ts) is a real RFC-4180 parser rather than a one-liner.

```csv
SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
20MICRONS,20 Microns Limited,EQ,06-OCT-2008,5,1,INE144J01027,5
21STCENMGM,21st Century Management Services Limited,EQ,03-MAY-1995,10,1,INE253B01015,10
360ONE,360 ONE WAM LIMITED,EQ,19-SEP-2019,1,1,INE466L01038,1
```

### Field mapping

| CSV column | App field | Transform |
|---|---|---|
| `SYMBOL` | `symbol` | trim; primary key |
| `NAME OF COMPANY` | `name` | trim |
| ` SERIES` | `series` | trim |
| ` DATE OF LISTING` | `listingDate` | `06-OCT-2008` → `2008-10-06` via `parseNseDate()` |
| ` PAID UP VALUE` | `paidUpValue` | `toNumber()`, strips commas, `null` on failure |
| ` MARKET LOT` | `marketLot` | `toNumber()` |
| ` ISIN NUMBER` | `isin` | trim |
| ` FACE VALUE` | `faceValue` | `toNumber()` |

The date format is the notable one: NSE uses `DD-MMM-YYYY` with a three-letter uppercase month. `parseNseDate()` in [format.ts](../src/lib/format.ts) maps it to ISO `yyyy-mm-dd`, which sorts correctly as plain text and drops straight into a Postgres `date` column.

### Series codes

**Measured distribution across all 2,397 rows:**

| Series | Count | Meaning |
|---|---|---|
| `EQ` | 2,075 | Rolling settlement. Normal trading, intraday allowed. |
| `BE` | 294 | Trade-to-trade. Delivery compulsory, no intraday, no netting. |
| `BZ` | 28 | Trade-to-trade under surveillance — typically companies with compliance issues. |

These three are exactly what the UI's series filter exposes, and the counts are asserted in the UI test.

### BSE — the scrip master

The feed behind BSE's own "List of Securities" page. JSON, not CSV.

```
https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active
```

The four empty query parameters are **required** — the endpoint expects them present-but-blank rather than absent. Headers mirror NSE's problem: it is served only to requests that look like they came from `bseindia.com`.

```http
User-Agent:      Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/120.0.0.0 Safari/537.36
Referer:         https://www.bseindia.com/
Origin:          https://www.bseindia.com
Accept:          application/json, text/plain, */*
```

**Measured response:** 1,789,959 bytes raw · 292,775 gzipped · **5,102 rows**, of which **5,099** are `Segment: Equity` + `Status: Active`. Roughly 30× the NSE CSV, which is why both proxies cache it for 6 hours.

```json
{ "SCRIP_CD": "500325", "scrip_id": "RELIANCE", "Scrip_Name": "Reliance Industries Ltd",
  "ISIN_NUMBER": "INE002A01018", "GROUP": "A", "FACE_VALUE": "10.00",
  "Status": "Active", "Segment": "Equity", "Mktcap": "..." }
```

| JSON field | App field | Notes |
|---|---|---|
| `scrip_id` | `symbol` (BSE-only rows) | Alphabetic ticker; also the Yahoo `.BO` stem |
| `SCRIP_CD` | `bseCode` | Numeric scrip code, BSE's own primary key |
| `Scrip_Name` | `name` | |
| `ISIN_NUMBER` | `isin` | **The join key.** Two rows carry the literal `"NA"` — rejected by a 12-character check, or they would merge two unrelated companies |
| `GROUP` | `series` | BSE settlement group (A, B, X, XT, T, Z, M, MT, P, …) — occupies the same column as NSE's series |
| `FACE_VALUE` | `faceValue` | |

BSE publishes no listing date, paid-up value or market lot, so those stay `null` on BSE-only rows.

### Merging the two lists

`mergeListings()` in [listings.ts](../src/lib/listings.ts) — reimplemented identically in [_shared/upstream.ts](../supabase/functions/_shared/upstream.ts) and [seed.mjs](../scripts/seed.mjs), because whichever runs decides what the table holds.

**Measured on live data:**

| | Count |
|---|---|
| NSE rows | 2,410 |
| BSE active equity scrips | 5,099 |
| Matched on ISIN (dual-listed) | 2,280 |
| NSE-only | 130 |
| BSE-only | 2,819 |
| **Merged total** | **5,229** |

Three rules, each earned from the data:

1. **Dual-listed companies keep everything NSE.** Symbol, series, listing date, and a `.NS` ticker — the NSE book is the more liquid of the two, so its last trade is the better price to show. The row only gains `BSE` in `exchanges` and the scrip code.
2. **ISIN must be well-formed to join on.** 12 alphanumerics. BSE's `"NA"` placeholders appear on two scrips that are otherwise unrelated.
3. **BSE tickers can collide with NSE ones.** Two do today: BSE's `FOCUS` is Focus Business Solution, NSE's is Focus Lighting and Fixtures; likewise `KALYANI`. Since `symbol` is the key quotes join on, the BSE-only row falls back to its numeric scrip code (`543312`), which can never collide with an NSE symbol. Yahoo is still queried by scrip id, so only the label changes.

---

## 2.2 Prices — Yahoo `v8/finance/spark`

```
https://query1.finance.yahoo.com/v8/finance/spark?symbols=<CSV>&range=1d&interval=1d
```

No authentication, no cookie, no crumb. Only a `User-Agent` is needed.

`range` and `interval` are free parameters, not fixed to the day — `range=10y&interval=1mo` returns ten years of monthly closes for twenty symbols in one request, which is what the screens' scan pass uses. Two behaviours worth knowing before relying on it: symbols Yahoo does not carry are **silently dropped** from the response object rather than returned as null (and a batch it recognises nothing in is a 404 for the whole request), and for thinly traded shares it **omits months** that `chart` returns a close for. The first is benign — every dropped symbol sampled also 404s on `chart` — but the second means a series from `spark` is not always the same series `chart` would give, which [§8.3](08-screens.md#83-three-passes-and-why) has to handle explicitly.

### Symbol mapping

NSE symbol + `.NS`, or BSE scrip id + `.BO`. `RELIANCE` → `RELIANCE.NS`; `TANFACIND` → `TANFACIND.BO`. Resolved once at merge time and stored as `Security.ticker` / `securities.yahoo_ticker`, because a BSE-only row's ticker cannot be derived from its display symbol.

> ⚠️ For BSE, use the **alphabetic scrip id, not the numeric scrip code**. Both resolve for older scrips (`504346.BO` and `RRP.BO` both work), but anything listed recently is reachable only by id — `544467.BO` (NSDL) 404s where `NSDL.BO` returns data. Measured across a 20-scrip sample spanning the whole list: id form 20/20, code form 16/20.

Symbols containing `&` (e.g. `M&MFIN`, `ARE&M`) **must** be URL-encoded or they truncate the query string. The code encodes the whole joined parameter with `encodeURIComponent()`. Note that `encodeURIComponent` also applies to the *path* of the chart endpoint, where it produces `ARE%26M.NS` — and `URL.pathname` keeps that escape rather than decoding it, so the Worker's allowlist has to permit `%`. See [Gotchas](07-gotchas.md).

### The 20-symbol hard cap

This is the single most important constraint in the app. Measured by bisection:

| Symbols/request | Result |
|---|---|
| 5, 10, **20** | ✅ 200 |
| **21**, 24, 25, 26, 28, 30, 40, 50, 100, 200, 400 | ❌ 400 Bad Request |

The cutoff is exactly 20. It is not caused by a bad ticker — every symbol in the failing set was verified individually. The whole request fails; it does not partially succeed.

**Consequence:** `ceil(2397 / 20)` = **120 requests** per full market refresh.

### Response shape

Keyed by ticker. Note that Yahoo **silently omits unknown tickers** rather than returning an error entry — so the code maps over the *request* batch, not the response keys, and produces a null-priced `Quote` for anything missing.

```json
{
  "RELIANCE.NS": {
    "symbol": "RELIANCE.NS",
    "timestamp": [1786074300],
    "close": [1334.8],
    "chartPreviousClose": 1325.0,
    "previousClose": null,
    "start": null, "end": null,
    "dataGranularity": 300
  },
  "TCS.NS": { "...": "..." }
}
```

### Derived fields

`buildQuote()` in [directSource.ts](../src/lib/directSource.ts) computes:

```
price          = last non-null value in close[]
previousClose  = chartPreviousClose ?? previousClose
change         = price - previousClose
changePercent  = change / previousClose * 100      (guarded against previousClose === 0)
updatedAt      = last timestamp[] × 1000, as ISO
```

`chartPreviousClose` is preferred because `previousClose` is frequently `null` in this endpoint's payload — visible in the sample above.

### Measured performance

| Metric | Result |
|---|---|
| Symbols priced | **2,396 / 2,397 (99.96%)** |
| Failed batches | **0 / 120** |
| Full refresh, server-side (Node, concurrency 6) | **3.4s** |
| Full refresh, browser via dev proxy | **~19s**, first prices at **~4s** |

The browser is slower for two structural reasons: Chrome permits only **6 concurrent connections per origin**, and the Vite dev proxy is a single HTTP/1.1 Node process. Neither applies in Supabase mode, where the browser makes one query and the fan-out happens server-side.

### Concurrency

Capped at **6** (`SPARK_CONCURRENCY`). Yahoo begins refusing connections above roughly 8 in parallel. `mapPool()` in [format.ts](../src/lib/format.ts) enforces it with a shared cursor rather than `Promise.all`, so exactly N requests are ever in flight.

---

## 2.3 History — Yahoo `v8/finance/chart`

```
https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>?range=<range>&interval=<interval>
```

One request per symbol. That is precisely why history is fetched on demand rather than ingested: keeping the whole market warm meant ~2,400 requests per pass and half a million stored rows, where a chart is only ever opened one symbol at a time.

There *is* a batch form for the closes alone — `spark` takes the same `range`/`interval` pair and answers twenty symbols at once. It is not a substitute here, because the drawer's chart needs OHLC and the screens need true intra-month highs, but it is what the screens' scan pass runs on: see [§8.3](08-screens.md#83-three-passes-and-why) for what a close-only series may and may not be used to conclude.

In the browser this is called through `/api/yahoo`, which is the Vite dev proxy under `npm run dev` and the Cloudflare Worker in a deployed build.

### Range → interval

| UI range | `range` | `interval` | Why |
|---|---|---|---|
| 1M | `1mo` | `1d` | daily bars |
| 6M | `6mo` | `1d` | daily bars |
| 1Y | `1y` | `1d` | daily bars |
| 5Y | `5y` | `1wk` | ~1,250 daily bars would be unreadable at 520px wide and slow to transfer |

### Response shape

Parallel arrays — `timestamp[i]` corresponds to `quote[0].close[i]`, and **any OHLCV entry can be `null`** (holidays, halts, missing prints).

```json
{
  "chart": {
    "result": [{
      "meta": { "currency": "INR", "symbol": "TCS.NS", "regularMarketPrice": 2452.7, "...": "..." },
      "timestamp": [1786074300, 1786160700],
      "indicators": {
        "quote": [{
          "open":   [2380.0, 2401.5],
          "high":   [2455.0, 2470.0],
          "low":    [2375.1, 2398.0],
          "close":  [2452.7, 2460.1],
          "volume": [3172884, 2884110]
        }]
      }
    }],
    "error": null
  }
}
```

Rows where `close` is null are filtered out — a gap in the line is correct, a zero would be a lie.

---

## 2.4 Fundamentals — screener.in company pages

Used by **screens only** ([§8](08-screens.md)) — nothing on the main table depends on it. The Chartink clause the screens implement has a ROCE leg and a market-cap band, and no other source here can answer either: the exchanges publish listings, not financials, and Yahoo's `quoteSummary` (which carries shares outstanding) now 401s without a crumb, so market cap cannot be reconstructed from a price.

```
https://www.screener.in/company/TITAN/consolidated/      # keyed by NSE symbol
https://www.screener.in/company/500325/consolidated/     # keyed by BSE scrip code
```

Both shapes were verified live. Only a browser `User-Agent` is needed — no cookie, no login.

### Why `/consolidated/`

The standalone page of a holding company reports a materially different ROCE. Reliance measures **7.78%** standalone against **10.3%** consolidated — opposite sides of this screen's `> 10` test. Screener.in serves the consolidated URL with a **200 even for companies that have none**, falling back to standalone figures itself, so there is no redirect to follow and no second request to make.

**Measured:** 227,474 bytes raw · 235,105 through the dev proxy · **no redirects** on any of the four companies tested · **404** for an unknown symbol.

### What is parsed

The ratio strip at the top of the page, which is server-rendered HTML:

```html
<ul id="top-ratios">
  <li><span class="name">Market Cap</span>
      <span class="value">₹ <span class="number">1,800,557</span> Cr.</span></li>
  <li><span class="name">ROCE</span> … <span class="number">10.3</span> % …
```

[fundamentals.ts](../src/lib/fundamentals.ts) reads every `<li>` into a name → numbers map and takes `Market Cap` (₹ crore, the same unit Chartink's `market cap` uses) and `ROCE` (percent). Parsing the whole strip rather than two hand-written patterns means P/E, book value or dividend yield cost nothing to add later.

### Failure modes and the request budget

| Situation | Response | Handling |
|---|---|---|
| Company not carried (SME scrips, renames) | 404 | `null` — the row is reported **unjudged**, never failed |
| Markup changes | 200, empty parse | same as above; a screen states how many rows it could not judge |
| Too many requests | 429 | paced and retried; `RateLimitedError` only once three backoffs are spent |

### The rate limit is a rate, not a quota

Worth stating that way round, because the two call for opposite responses — a quota means give up, a rate means slow down. Measured 2026-08-12, serial requests to distinct company pages:

| gap between requests | outcome |
|---|---|
| none | 429 from the 17th |
| 250 ms | 429 from the ~25th |
| 600 ms | 429 from the 35th |
| **1.2 s** | **60 of 60, no 429** |
| 2.5 s | 40 of 40, no 429 |

At four unthrottled connections a screen hit the wall about twenty rows in and aborted, which on a 2,410-row NSE universe meant the fundamental legs were **effectively never evaluated** — and, until the price passes were fixed to judge the whole clause, every row the fundamentals pass never reached was still being reported as a match.

`MIN_INTERVAL_MS = 1200` in [fundamentals.ts](../src/lib/fundamentals.ts) gates every request through one shared schedule, and a 429 pushes *all* queued callers back rather than just the one that got it — the limit is on the origin, so backing off alone while the rest keep firing only holds the block open. **Measured after the change: 115 survivors, 137s, zero 429s.**

This is the only scraped source in the app and the only one with no contract at all, which is why nothing downstream treats a missing number as a failed test.

It is also the most expensive per row, so the runner never asks it about a row that has already failed on price or momentum — of the 30-name sample screened during development, **6 reached this source**. Both proxies cache responses for 6 hours; the numbers behind them are a daily market cap over quarterly financials, so that costs accuracy nothing.

---

## 2.5 Rejected: Yahoo `v7/finance/quote`

The obvious choice, and it no longer works anonymously.

```console
$ curl "https://query1.finance.yahoo.com/v7/finance/quote?symbols=RELIANCE.NS,TCS.NS,INFY.NS"
{"finance":{"result":null,"error":{"code":"Unauthorized",
 "description":"User is unable to access this feature - https://bit.ly/yahoo-finance-api-feedback"}}}
http=401
```

It now requires a cookie + crumb handshake. That is doable but fragile — the crumb rotates and the flow breaks without warning. `spark` needs none of it, which is why it was chosen despite the 20-symbol cap.

**If you find a tutorial using `v7/finance/quote` without auth, it is out of date.**

## 2.6 Rejected: Angel One SmartAPI scrip master

```
https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
```

Connection timeout on every attempt (curl exit 28). May be geo-restricted or simply unreliable. Not pursued further since NSE's own CSV is strictly better for this purpose.

## 2.7 Viable fallbacks (not used)

Both work without authentication and are worth knowing about if NSE's archive ever moves.

### Zerodha Kite instruments dump

```
https://api.kite.trade/instruments
```

✅ 200 · 9,157,738 bytes · CSV · **no auth despite being a broker API**.

```csv
instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
```

Filtering `exchange == "NSE"` gives 10,035 rows, of which `segment == "NSE"` gives 9,899 and `segment == "INDICES"` gives 136.

**Why it wasn't used:** those 9,899 "cash equities" include government securities (`656KA30-SG`), SME scrips (`GOLDSTAR-SM`), ETFs and bonds. Extracting the ~2,400 genuinely listed companies means maintaining a suffix/series blocklist. `EQUITY_L.csv` is that set already. It also has no ISIN or listing date.

### Dhan scrip master

```
https://images.dhan.co/api-data/api-scrip-master.csv
```

✅ 200 · 26,007,743 bytes.

Filtering `SEM_EXM_EXCH_ID == 'NSE'` and `SEM_INSTRUMENT_NAME == 'EQUITY'` gives 9,696 rows. **Measured series distribution:**

| Series | Count | | Series | Count |
|---|---|---|---|---|
| SG (state govt) | 4,295 | | ST | 138 |
| **EQ** | **2,450** | | GS (govt sec) | 130 |
| N0 | 971 | | MF | 119 |
| SM (SME) | 422 | | N1 | 107 |
| **BE** | **285** | | TB (T-bills) | 84 |

This *does* carry `SEM_SERIES`, so filtering to EQ/BE is possible — but it means downloading 26 MB to extract what a 169 KB file already contains, and its EQ count (2,450) does not match NSE's own (2,075), because Dhan includes recently suspended scrips.

---

## 2.8 Legal and practical notes

- All endpoints are public and unauthenticated. None are scraped from behind a login.
- **Prices are delayed.** Yahoo does not provide real-time NSE data on the free tier. The UI states this permanently in the status bar.
- **Not for trading.** Nothing here is suitable for order execution or investment decisions.
- These are undocumented endpoints belonging to third parties. They can change or disappear without notice — the adapter boundary in [types.ts](../src/types.ts) exists partly so replacing one is a contained change.
- For a production system with real obligations, use a licensed vendor feed (NSE DotEx, Refinitiv) or a broker API with a data subscription (Kite Connect, ~₹2,000/month).

---

Next: [Boot flow →](03-boot-flow.md)
