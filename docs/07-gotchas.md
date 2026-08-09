[← Build from scratch](06-build-from-scratch.md) · [Docs index](README.md)

# 7. Gotchas & debugging

The failures actually hit while building this — what the symptom looked like, how it was diagnosed, and what fixed it. Recorded because most cost real time and none was obvious from the symptom.

---

## 1. NSE's WAF hangs on browser header fingerprints

**The hardest bug here.** Worth reading even if you never touch NSE.

### Symptom

`curl` through the dev proxy: **200, 169 KB, instant**. The exact same URL from the browser: **hangs forever**. No error, no timeout, no console message, no failed request — the fetch simply never settled. The app sat on "Fetching the NSE equity list…" indefinitely.

### Diagnosis

Playwright showed the request being *issued* but never answered:

```
[req] http://localhost:5199/api/nse/content/equities/EQUITY_L.csv
[req] http://localhost:5199/api/nse/content/equities/EQUITY_L.csv
(no [res] ever)
```

Captured Chromium's exact headers and replayed them through curl:

```console
$ curl -H 'sec-ch-ua-platform: "Windows"' -H 'referer: http://localhost:5199/' \
       -H 'user-agent: Mozilla/5.0 … HeadlessChrome/130 …' \
       -H 'sec-ch-ua: "Chromium";v="130", …' -H 'sec-ch-ua-mobile: ?0' "$URL"
exact-chromium-headers: 000 0 time=20.005689
curl exit=28    # timed out — reproduced outside the browser
```

Then bisected. **Every header individually returned 200:**

```
lowercase user-agent    200 169183
lowercase referer       200 169183
lowercase accept        200 169183
sec-ch-ua only          200 169183
capital User-Agent      200 169183
```

Only the *combination* failed:

```
ua(full chrome string)          200 169183
ua + referer                    200 169183
ua + referer + sec-ch-ua        TIMEOUT   ← here
```

### Root cause

Vite's `server.proxy.headers` option **merges** headers rather than replacing them. The browser's own `referer`, `sec-ch-ua` and `user-agent` stayed on the outgoing request alongside the configured ones. NSE's WAF fingerprints that combination and **blackholes it** — no RST, no 403, just silence.

An earlier hypothesis — duplicate `Referer` headers from the case mismatch between Chromium's lowercase `referer` and the config's `Referer` — was **wrong**, and testing it disproved it cleanly (`curl -H 'Referer: http://localhost:5199/'` returned 200).

### Fix

Replace the header set entirely, using `configure` + `proxyReq` so Node's case-insensitive `setHeader` cannot produce duplicates:

```ts
const PRESERVED_HEADERS = new Set(['host', 'connection', 'content-length']);

function replaceHeaders(proxyReq: ClientRequest, headers: Record<string, string>) {
  for (const name of proxyReq.getHeaderNames()) {
    if (!PRESERVED_HEADERS.has(name.toLowerCase())) proxyReq.removeHeader(name);
  }
  for (const [key, value] of Object.entries(headers)) proxyReq.setHeader(key, value);
}
```

Verified: the previously-hanging header set now returns `200 57448`.

### Transferable lessons

- **A hang is a symptom, not an absence of one.** WAFs blackhole rather than reject, specifically to waste a scraper's time.
- **When curl works and the browser doesn't, the difference is headers.** Capture the real ones and replay them.
- **Bisect combinations, not just individual items.** Every header passed alone here; only the triple failed.
- **Test the disproof.** The duplicate-`Referer` theory was plausible and wrong; one command settled it.

---

## 2. Progressive loading that wasn't progressive

### Symptom

The table sat entirely empty for ~45 seconds, then populated all at once. The progress bar stayed at 0% the whole time despite requests clearly completing.

### Diagnosis

Polling the DOM over time — rather than checking the final state — made it obvious:

```
t=7s   res=29   chips=0  | 0 advancing · 0 declining
t=12s  res=43   chips=0  | 0 advancing · 0 declining
t=22s  res=60   chips=0  | 0 advancing · 0 declining
t=37s  res=81   chips=0  | 0 advancing · 0 declining
t=42s  res=118  chips=0  | 0 advancing · 0 declining
t=47s  res=120  chips=30 | 1025 advancing · 1233 declining   ← everything, at once
```

118 responses had arrived and **not one row had updated**. That ruled out the network and pointed straight at the callback.

### Root cause

`onBatch` was being called in a loop *after* the pool had fully drained:

```ts
const results = await mapPool(batches, 6, async (batch) => { … return quotes; });

// ← every batch has already completed by the time this runs
for (const batchResult of results) {
  onBatch?.(batchResult);
}
```

Structurally it looks like streaming. It is a no-op: `await mapPool(...)` does not resolve until all 120 requests finish, so all 120 callbacks fire in the same tick.

### Fix

Call it inside the worker, as each batch resolves:

```ts
const quotes = batch.map((symbol) => buildQuote(symbol, payload[toYahooSymbol(symbol)]));
if (quotes.length > 0) onBatch?.(quotes);   // inside the pool worker
return quotes;
```

| | Before | After |
|---|---|---|
| First prices | ~45s | **~4s** |
| Full market | ~47s | ~19s |
| Progress bar | 0% → 100% | 18% → 60% → 77% → 98% → done |

### Transferable lesson

**Assert intermediate states, not just final ones.** Every end-state test passed both before and after this fix — correct prices, correct breadth, correct count. The bug lived entirely in the timeline. Any test that only checks "did it end up right" is blind to it.

---

## 3. A sorting bug that wasn't

Recorded because the *misdiagnosis* is more instructive than a real bug would have been.

### Apparent symptom

A test clicked the Chg % header twice, labelled the result "TOP GAINER", and printed:

```
TOP GAINER : IXIGO | -13.04%
TOP LOSER  : 20MICRONS | -1.38%
```

Both look wrong. The conclusion drawn — that TanStack had inferred a string comparator — was announced as a bug.

### Actual cause

The test was wrong, not the code.

- **TanStack sorts numeric columns descending on the first click.** Two clicks is therefore *ascending*, and -13.04% is the correct top of an ascending Chg % sort — the day's biggest loser.
- The third click hit the default `enableSortingRemoval` behaviour, clearing sorting entirely and reverting to data order — hence `20MICRONS`, the alphabetically first symbol.

Re-tested with correct labels and a monotonicity assertion:

```
click1 caret=▼  first=19.99,19.99,17.98  strictly non-increasing=true
click2 caret=▲  first=-13.04,-11.24,-10.82  strictly non-decreasing=true
LTP    caret=▼  first=134190,112260,42950  non-increasing=true
most expensive: MRF | MRF Limited | 1,34,190.00
```

All correct, and correct before the "fix".

### What was kept anyway

- `sortingFn: numericSort` — inference is *currently* correct but depends on the top rows carrying numbers; stating it removes the dependency.
- `enableSortingRemoval: false` — the third-click-clears behaviour genuinely reads as a bug on a screener.
- Scroll reset on sort — sorting while scrolled down otherwise hides the rows you sorted for.

Defensible as hardening. Not a bug fix, and the code comment claiming otherwise was corrected.

### Transferable lessons

- **Know your library's defaults before calling its behaviour a bug.** Descending-first for numeric columns is documented TanStack behaviour.
- **Assert properties, not eyeballed values.** "Is this sequence monotonic" cannot be fooled by a mislabelled variable; "is the first row the top gainer" can.
- **Say so when a claimed bug evaporates.** Leaving the claim standing would have left a misleading comment in the source and a false entry in these docs.

---

## 4. Orphaned dev servers

### Symptom

Config changes had no effect. The proxy fix was verified working by curl, yet the browser still hung.

### Diagnosis

```console
$ cat vite3.log
Port 5199 is in use, trying another one...
Port 5200 is in use, trying another one...
➜  Local:   http://localhost:5201/

$ netstat -ano | grep 5199
TCP  [::1]:5199  LISTENING  21228
```

Stopping the background task killed the *wrapper*, not the `node` child. Port 5199 was still served by the original process with the **old config**, while each restart landed on a new port. The browser was talking to a stale server.

### Fix

```bash
pid=$(netstat -ano | grep LISTENING | grep ":5199 " | head -1 | awk '{print $NF}')
taskkill //F //PID $pid
```

(Double slashes are for Git Bash on Windows, which otherwise mangles `/F` into a path.)

### Lesson

**Confirm which process is answering before concluding a fix didn't work.** The port a server *wanted* is not necessarily the port it got, and Vite's fallback is quiet — one line in a log nobody reads.

---

## 5. Stale Vite dependency cache

### Symptom

After restarting the dev server, a blank page and:

```
Failed to load resource: 504 (Outdated Optimize Dep)
http://localhost:5199/node_modules/.vite/deps/react.js?v=19e022c6  net::ERR_ABORTED
```

### Cause

Vite pre-bundles dependencies into `node_modules/.vite/deps` with a hash in the URL. After a restart the browser requested the previous hash.

### Fix

```bash
rm -rf node_modules/.vite
npx vite --force
```

A hard reload usually suffices in normal use; this needed clearing because the server had been killed mid-optimisation.

---

## 6. `networkidle` never fires

### Symptom

```
page.goto: Timeout 60000ms exceeded.
  - navigating to "http://localhost:5199/", waiting until "networkidle"
```

### Cause

Vite's HMR websocket stays open permanently, so the network is *never* idle. The app's 120 concurrent quote requests compound it.

### Fix

Use `domcontentloaded` and wait on a real selector:

```js
await p.goto(url, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tr');
```

**Never use `networkidle` against a Vite dev server.** Waiting for an application-meaningful condition is better practice regardless.

---

## 7. Browser concurrency ≠ server concurrency

### Observation

The same 120-request workload:

| Environment | Time |
|---|---|
| Node script → proxy | **3.4s** |
| Chromium → proxy | **~19s** |

### Cause

Two structural limits, neither fixable in application code:

1. **Chrome allows 6 concurrent connections per origin** over HTTP/1.1. `SPARK_CONCURRENCY` of 6 exactly saturates it, competing with Vite's own module requests and HMR socket.
2. **The Vite dev proxy is a single HTTP/1.1 Node process**, opening a fresh TLS connection to Yahoo per request.

Raising `SPARK_CONCURRENCY` does not help — Chrome queues past 6 regardless.

### Why it's acceptable

Direct mode is a development and evaluation convenience. In Supabase mode the browser makes **2 requests**, and the 120-request fan-out happens server-side where the 3.4s figure applies. Progressive streaming means the table is usable at ~4s either way.

---

## 8. PostgREST's silent 1,000-row cap

### Symptom (anticipated, not observed)

Supabase mode shows 1,000 shares instead of 2,397 — with no error.

### Cause

PostgREST caps `select` responses at 1,000 rows by default. You get a valid response containing part of the data.

### Fix

Paginate explicitly:

```ts
for (let page = 0; ; page++) {
  const from = page * PAGE_SIZE;
  const { data, error } = await client().from(table).select(columns).order(orderBy)
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(`${table}: ${error.message}`);
  const rows = (data ?? []) as T[];
  out.push(...rows);
  if (rows.length < PAGE_SIZE) return out;   // short page = last page
}
```

The termination condition is a **short page**, not an empty one — otherwise an exactly-2,000-row table costs a redundant round trip, and an off-by-one drops the tail.

### Lesson

**Silent truncation is worse than an error.** A 1,000-row table looks like working software. Any list endpoint with a default limit deserves pagination the first time it is written, not after someone notices missing data.

---

## 9. Node 18 vs Vite 7

`vite@latest` (v7) requires Node 20+; this machine runs 18.20.3. Pinned to `vite@^5.4.9`.

`npm install` also warns:

```
npm warn EBADENGINE package: '@supabase/storage-js@2.112.2' required: { node: '>=22.0.0' }
```

Harmless — `@supabase/supabase-js` only executes in the browser bundle here. Verified by a clean `vite build`.

---

## 10. NSE date format

`06-OCT-2008` — `DD-MMM-YYYY` with an uppercase three-letter month. `new Date('06-OCT-2008')` is unreliable across engines.

```ts
const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', /* … */ };

export function parseNseDate(value: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}
```

Returns ISO `yyyy-mm-dd`, which sorts correctly as text and inserts directly into a Postgres `date`. Returns `null` rather than throwing — one malformed row should not fail the load of 2,396 good ones.

---

## Debugging checklist

When something breaks, in order of how often it was the answer here:

1. **Is the process you're testing the one that's running?** `netstat -ano | grep LISTENING`
2. **Does `curl` reproduce it?** If curl works and the browser doesn't → headers.
3. **Is it hanging or failing?** A hang usually means a WAF, not a bug.
4. **Are intermediate states right, or only the final one?** Poll over time.
5. **Is the library's default what you assumed?** Check before calling it a bug.
6. **Is data being silently truncated?** Count rows against a known-good number.
