import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { ClientRequest } from 'node:http';

/**
 * Dev-only proxy to NSE, BSE and Yahoo. None of them sends CORS headers, so the
 * browser cannot call them directly; all three are fetched server-side here.
 *
 * The proxy deliberately *replaces* the request headers rather than adding to
 * them. Vite's `proxy.headers` option only merges, which leaves Chromium's own
 * `referer` / `sec-ch-ua` / `sec-fetch-*` headers on the outgoing request — and
 * NSE's WAF silently blackholes that combination (the request hangs until it
 * times out rather than returning an error). Stripping to a known-good set
 * makes the proxied request look exactly like the curl request that works.
 *
 * In a production build this proxy does not exist; set VITE_SUPABASE_URL and the
 * app reads pre-ingested rows from Supabase instead.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Everything else the browser sent is dropped before the request leaves Node. */
const PRESERVED_HEADERS = new Set(['host', 'connection', 'content-length']);

function replaceHeaders(proxyReq: ClientRequest, headers: Record<string, string>) {
  for (const name of proxyReq.getHeaderNames()) {
    if (!PRESERVED_HEADERS.has(name.toLowerCase())) proxyReq.removeHeader(name);
  }
  // setHeader is case-insensitive, so this can never produce a duplicate.
  for (const [key, value] of Object.entries(headers)) proxyReq.setHeader(key, value);
}

const NSE_HEADERS = {
  'User-Agent': BROWSER_UA,
  // NSE only serves the archives to requests that look like they came from its site.
  Referer: 'https://www.nseindia.com/',
  Accept: 'text/csv,application/csv,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
};

/**
 * BSE's API is the one its own site calls, and it is served only to requests
 * that look like they came from there — hence the Referer and Origin. Unlike
 * NSE it answers JSON, so the Accept header differs too.
 */
const BSE_HEADERS = {
  'User-Agent': BROWSER_UA,
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
};

const YAHOO_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
};

/**
 * Screener.in, the fundamentals source behind the ROCE and market-cap legs of
 * the screens in src/lib/screens.ts. It serves HTML, not JSON — the numbers are
 * scraped out of the company page's ratio list.
 *
 * `Accept-Encoding` is deliberately absent: Vite streams the upstream body
 * through untouched, and asking for gzip here would hand the browser bytes it
 * has been told are `text/html` but cannot decode. The JSON upstreams get away
 * with it because their responses are small enough that Node negotiates
 * identity anyway; a 220 KB company page does not.
 */
const SCREENER_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

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
      '/api/bse': {
        target: 'https://api.bseindia.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bse/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => replaceHeaders(proxyReq, BSE_HEADERS));
        },
      },
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => replaceHeaders(proxyReq, YAHOO_HEADERS));
        },
      },
      '/api/screener': {
        target: 'https://www.screener.in',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/screener/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => replaceHeaders(proxyReq, SCREENER_HEADERS));
        },
      },
    },
  },
});
