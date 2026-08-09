[← Overview](01-overview.md) · [Docs index](README.md) · Next: [Boot flow →](03-boot-flow.md)

# 2. Data sources

Every endpoint used, every endpoint rejected, with the evidence behind each decision. All results here were measured, not assumed.

## Summary

| Source | Auth | Status | Supplies |
|---|---|---|---|
| NSE `EQUITY_L.csv` | none (needs `Referer`) | ✅ used | The 2,397-share master list |
| Yahoo `v8/finance/spark` | none | ✅ used | LTP + previous close, 20 symbols/request |
| Yahoo `v8/finance/chart` | none | ✅ used | OHLCV history, 1 symbol/request |
| Zerodha Kite `/instruments` | none | ⚪ viable fallback | 9,899 NSE instruments (noisy) |
| Dhan scrip master | none | ⚪ viable fallback | 26 MB, all segments |
| Yahoo `v7/finance/quote` | crumb required | ❌ rejected | 401 Unauthorized |
| Angel One scrip master | none | ❌ rejected | connection timeout |

---

## 2.1 The master list — NSE `EQUITY_L.csv`

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

---

## 2.2 Prices — Yahoo `v8/finance/spark`

```
https://query1.finance.yahoo.com/v8/finance/spark?symbols=<CSV>&range=1d&interval=1d
```

No authentication, no cookie, no crumb. Only a `User-Agent` is needed.

### Symbol mapping

NSE symbol + `.NS` suffix. `RELIANCE` → `RELIANCE.NS`.

Symbols containing `&` (e.g. `M&MFIN`, `ARE&M`) **must** be URL-encoded or they truncate the query string. The code encodes the whole joined parameter with `encodeURIComponent()`.

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

One request per symbol — there is no batch form. This is why candles cannot be refreshed for the whole market in a single pass.

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

## 2.4 Rejected: Yahoo `v7/finance/quote`

The obvious choice, and it no longer works anonymously.

```console
$ curl "https://query1.finance.yahoo.com/v7/finance/quote?symbols=RELIANCE.NS,TCS.NS,INFY.NS"
{"finance":{"result":null,"error":{"code":"Unauthorized",
 "description":"User is unable to access this feature - https://bit.ly/yahoo-finance-api-feedback"}}}
http=401
```

It now requires a cookie + crumb handshake. That is doable but fragile — the crumb rotates and the flow breaks without warning. `spark` needs none of it, which is why it was chosen despite the 20-symbol cap.

**If you find a tutorial using `v7/finance/quote` without auth, it is out of date.**

## 2.5 Rejected: Angel One SmartAPI scrip master

```
https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
```

Connection timeout on every attempt (curl exit 28). May be geo-restricted or simply unreliable. Not pursued further since NSE's own CSV is strictly better for this purpose.

## 2.6 Viable fallbacks (not used)

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

## 2.7 Legal and practical notes

- All endpoints are public and unauthenticated. None are scraped from behind a login.
- **Prices are delayed.** Yahoo does not provide real-time NSE data on the free tier. The UI states this permanently in the status bar.
- **Not for trading.** Nothing here is suitable for order execution or investment decisions.
- These are undocumented endpoints belonging to third parties. They can change or disappear without notice — the adapter boundary in [types.ts](../src/types.ts) exists partly so replacing one is a contained change.
- For a production system with real obligations, use a licensed vendor feed (NSE DotEx, Refinitiv) or a broker API with a data subscription (Kite Connect, ~₹2,000/month).

---

Next: [Boot flow →](03-boot-flow.md)
