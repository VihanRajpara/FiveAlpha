import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { ClientRequest } from 'node:http';

/**
 * Dev-only proxy to NSE and Yahoo. Neither sends CORS headers, so the browser
 * cannot call them directly; both are fetched server-side here instead.
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

const YAHOO_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
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
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => replaceHeaders(proxyReq, YAHOO_HEADERS));
        },
      },
    },
  },
});
