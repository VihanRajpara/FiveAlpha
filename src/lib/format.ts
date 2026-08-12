const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** NSE publishes listing dates as `06-OCT-2008`; normalise to `2008-10-06`. */
export function parseNseDate(value: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toUpperCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPrice(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : inr.format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatVolume(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

/** A figure already denominated in ₹ crore — market cap, as screener.in states it. */
export function formatCrore(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/**
 * How far below a high a price sits, given the price as a percentage *of* that
 * high. The screen's own arithmetic is `close / high`, but nobody reads a stock
 * as "91.8% of its ten-year high" — they read it as 8.2% off it, so the sign is
 * flipped for display and the boundary case gets a word instead of "-0.0%".
 */
export function formatFromHigh(pctOfHigh: number | null | undefined): string {
  if (pctOfHigh === null || pctOfHigh === undefined) return '—';
  const below = 100 - pctOfHigh;
  if (below < 0.05) return 'at high';
  return `−${below.toFixed(1)}%`;
}

/**
 * Human-readable age of a timestamp: "just now", "12 min ago", "3 h ago", "2 d ago".
 * Used to state how old the prices actually are, rather than when they were fetched.
 */
export function formatAge(from: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Date + time in IST, e.g. "07 Aug, 3:15 pm". */
export function formatIstDateTime(d: Date): string {
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Whether the NSE cash market is in its continuous session right now
 * (09:15–15:30 IST, Mon–Fri), computed in IST regardless of the viewer's zone.
 *
 * Trading holidays are NOT accounted for — NSE publishes them as a separate
 * calendar this app doesn't ingest. So a holiday reads as "open", which only
 * affects whether stale prices are flagged, never the prices themselves.
 */
export function isMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const minutesOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  return minutesOfDay >= 9 * 60 + 15 && minutesOfDay <= 15 * 60 + 30;
}

/** Splits a list into fixed-size chunks (Yahoo's spark endpoint caps at 20 symbols). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs `worker` over `items` with bounded concurrency, rather than Promise.all
 * over thousands of requests at once.
 *
 * The bound used to be justified by Yahoo throttling "above ~8 parallel
 * connections". That does not survive measurement — see `TECHNICAL_CONCURRENCY`
 * in src/hooks/useScreen.ts, where 32 in flight returned no errors at all. The
 * real reasons to keep it are the ones that do not depend on the upstream: the
 * browser's own per-origin limit, and not queueing 5,000 sockets to be polite
 * to someone else's server.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
