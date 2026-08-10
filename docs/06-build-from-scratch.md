[← Supabase backend](05-backend-supabase.md) · [Docs index](README.md) · Next: [Gotchas →](07-gotchas.md)

# 6. Build from scratch

Rebuilding this from an empty folder, in the order the pieces actually depend on each other.

## 6.0 Prerequisites

```bash
node -v    # 18.20.3 — v18+ required
npm -v     # 10.7.0
```

**Version constraint:** Vite 7 requires Node 20+. On Node 18, pin Vite 5 (this project) or Vite 6. Installing `vite@latest` on Node 18 produces a confusing runtime failure, not a clean error.

## 6.1 Verify the data sources first

Do this **before writing any code**. The whole architecture depends on which endpoints actually work, and answering that takes two minutes.

```bash
# The master list — needs the Referer, otherwise 403
curl -s -o eqL.csv -w "%{http_code} %{size_download}\n" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)" \
  -H "Referer: https://www.nseindia.com/" \
  "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
# expect: 200 169183

# Prices, batched, no auth
curl -s -H "User-Agent: Mozilla/5.0" \
  "https://query1.finance.yahoo.com/v8/finance/spark?symbols=RELIANCE.NS,TCS.NS&range=1d&interval=1d"
# expect: JSON keyed by ticker

# Confirm the batch cap yourself — 20 works, 21 doesn't
```

Finding the 20-symbol cap here rather than after building the UI is the difference between a clean design and a rewrite. See [Data sources](02-data-sources.md) for everything this turned up.

## 6.2 Scaffold

Created by hand rather than via `npm create vite` — the template ships extra files (ESLint config, SVG assets, `App.css`) that then have to be deleted.

```bash
mkdir NSE && cd NSE
```

**`package.json`**

```json
{
  "name": "nse-listed-shares",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --noEmit"
  }
}
```

`"type": "module"` is required — `vite.config.ts` uses ESM syntax.

```bash
npm install react react-dom @tanstack/react-table @tanstack/react-virtual @supabase/supabase-js
npm install -D vite@^5.4.9 @vitejs/plugin-react typescript @types/react @types/react-dom @types/node
```

> `npm install` prints `EBADENGINE` warnings for two `@supabase/supabase-js` sub-dependencies declaring Node 22. Harmless — that package only runs in the browser bundle.

**`tsconfig.json`** — the two non-default choices:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,          // catches dead imports at build time
    "types": ["vite/client", "node"] // "node" is needed for vite.config.ts
  },
  "include": ["src", "vite.config.ts"],  // vite.config.ts must be included or the IDE flags node:http
  "exclude": ["supabase"]                // Deno functions use remote imports; tsc can't resolve them
}
```

**`index.html`** at the project root (not in `public/`) — Vite treats it as the entry module.

## 6.3 The proxy

Write this next. Nothing can be tested until data reaches the browser.

```ts
// vite.config.ts
const PRESERVED_HEADERS = new Set(['host', 'connection', 'content-length']);

function replaceHeaders(proxyReq: ClientRequest, headers: Record<string, string>) {
  for (const name of proxyReq.getHeaderNames()) {
    if (!PRESERVED_HEADERS.has(name.toLowerCase())) proxyReq.removeHeader(name);
  }
  for (const [key, value] of Object.entries(headers)) proxyReq.setHeader(key, value);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/nse': {
        target: 'https://nsearchives.nseindia.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nse/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => replaceHeaders(proxyReq, NSE_HEADERS));
        },
      },
      // …/api/yahoo likewise
    },
  },
});
```

> **Use `configure` + `proxyReq`, not the `headers` option.** The `headers` option *merges*, leaving the browser's own `referer` / `sec-ch-ua` in place — and NSE's WAF hangs on that combination. This costs an hour to diagnose if you get it wrong; see [Gotchas §1](07-gotchas.md#1-nses-waf-hangs-on-browser-header-fingerprints).

Verify the proxy independently of React:

```bash
npm run dev
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" \
  "http://localhost:5173/api/nse/content/equities/EQUITY_L.csv"
# expect: 200 169183
```

## 6.4 Types before implementations

Define the contract first — it is what makes the two backends interchangeable.

```ts
// src/types.ts
export interface DataSource {
  readonly kind: 'direct' | 'supabase';
  listSecurities(): Promise<Security[]>;
  fetchQuotes(targets: QuoteTarget[], onBatch?: (batch: Quote[]) => void): Promise<Quote[]>;
  fetchCandles(ticker: string, range: ChartRange): Promise<Candle[]>;
}
```

The `onBatch` callback in the signature is the design decision that makes progressive rendering possible. Adding it later means changing every call site.

## 6.5 Build order

Each step is verifiable before the next begins.

| # | Build | Verify by |
|---|---|---|
| 1 | `lib/csv.ts` — RFC-4180 parser | parse `EQUITY_L.csv`, assert 2,397 rows |
| 2 | `lib/format.ts` — `parseNseDate`, `toNumber`, `chunk`, `mapPool` | `parseNseDate('06-OCT-2008') === '2008-10-06'` |
| 3 | `lib/directSource.ts` | `listSecurities()` returns 2,397 typed objects |
| 4 | `hooks/useMarketData.ts` | `loading` flips false, `securities.length === 2397` |
| 5 | `components/StockTable.tsx` | rows paint with shimmer placeholders |
| 6 | quote streaming | prices fill in progressively, not in one jump |
| 7 | `StockDetail` + `PriceChart` | drawer opens, chart draws |
| 8 | `lib/supabaseSource.ts` | typechecks; exercised only once a project exists |
| 9 | `supabase/` migrations + functions | `supabase db push` |

**Write the CSV parser properly at step 1.** `split(',')` appears to work — the first ~200 rows have no quoted commas — and corrupts rows further down where company names contain them. That is a bug you find much later, in data, not in a stack trace.

## 6.6 Validating at scale

Unit-level correctness does not tell you whether 120 batched requests will be throttled. Test that directly:

```js
// scratch script, run with node
const syms = /* 2,397 symbols parsed from the CSV */;
const chunks = []; for (let i = 0; i < syms.length; i += 20) chunks.push(syms.slice(i, i + 20));

let priced = 0, failed = 0, cursor = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (cursor < chunks.length) {
    const batch = chunks[cursor++];
    const q = encodeURIComponent(batch.map(s => s + '.NS').join(','));
    const r = await fetch(`http://localhost:5173/api/yahoo/v8/finance/spark?symbols=${q}&range=1d&interval=1d`);
    if (!r.ok) { failed++; continue; }
    const j = await r.json();
    for (const s of batch) if (j[s + '.NS']?.close?.some(c => typeof c === 'number')) priced++;
  }
}));
```

**Measured:** `priced: 2396/2397 (100.0%) · failed batches: 0/120 · elapsed: 3.4s`

That single result confirmed the batch size, the concurrency limit, the symbol mapping and the absence of throttling — before any of it was wired into React.

## 6.7 Verifying the UI for real

A typecheck proves nothing about whether the table renders. Drive a real browser:

```bash
npm install -D playwright
npx playwright install chromium
```

```js
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1480, height: 900 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));

await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tr');
await p.waitForTimeout(20000);

console.log(await p.locator('.brand .count').textContent());   // "2,397 of 2,397"
console.log(await p.locator('.chg-chip').count());             // 30 — virtualized
await p.screenshot({ path: 'table.png' });
```

Three things this catches that nothing else does:

- **Use `domcontentloaded`, never `networkidle`.** The HMR websocket stays open forever, so `networkidle` always times out.
- **Assert progressive behaviour over time**, not just the end state. Polling `.chg-chip` count every 3s is what exposed the streaming bug — the final state was correct, the intermediate states were not.
- **Assert ordering, not just presence.** Read a column's rendered values and check monotonicity; "the table has rows" passes even when sorting is broken.

## 6.8 Commands reference

```bash
npm run dev          # dev server + proxy on :5173
npm run build        # tsc -b && vite build → dist/
npm run preview      # serve dist/ (needs Supabase configured — no proxy)
npm run typecheck    # tsc -b --noEmit
```

## 6.9 Common setup mistakes

| Symptom | Cause |
|---|---|
| `EQUITY_L.csv` returns 403 | Missing `Referer: https://www.nseindia.com/` |
| The request hangs forever, no error | Browser headers forwarded — proxy is merging, not replacing |
| Yahoo returns 400 | More than 20 symbols in one `spark` call |
| Yahoo returns 401 | Using `v7/finance/quote` — needs a crumb; use `v8/finance/spark` |
| Table shows 1,000 rows in Supabase mode | PostgREST's default cap — paginate with `.range()` |
| Prices appear all at once after ~45s | `onBatch` called after `await mapPool(...)` instead of inside the worker |
| Vite fails on Node 18 | Vite 7 needs Node 20+; pin Vite 5 |
| `Cannot find module 'node:http'` | `@types/node` missing, or `vite.config.ts` not in tsconfig `include` |

---

Next: [Gotchas & debugging →](07-gotchas.md)
