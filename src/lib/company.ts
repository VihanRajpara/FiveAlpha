import { fetchScreenerPage, screenerPaths } from './fundamentals';
import type { Security } from '../types';

/**
 * The rest of a screener.in company page: the ratio strip, the machine-generated
 * pros and cons, and the six financial tables.
 *
 * A companion to fundamentals.ts rather than part of it, because the two want
 * opposite things from the same page. That one takes two numbers off hundreds of
 * pages during a screen and must be as cheap as possible per row; this one takes
 * everything off *one* page, on a click, and can afford a DOM parse.
 *
 * What they do share is the request: the same paced fetcher, so a click while a
 * screen is running joins that queue instead of racing it into a 429, and the
 * same 6h `Cache-Control` from the Worker.
 *
 * Everything here is a scrape of markup with no contract behind it. A section
 * that has moved parses as absent, and the drawer shows the sections it got —
 * one changed `id` must not take the whole panel down.
 */

/** The tables lifted whole, in the order screener.in prints them. */
const TABLE_IDS = [
  'quarters',
  'profit-loss',
  'balance-sheet',
  'cash-flow',
  'ratios',
  'shareholding',
] as const;

export interface FinTable {
  id: string;
  title: string;
  /** "Consolidated Figures in Rs. Crores", "Numbers in percentages", … */
  note: string;
  /** Period headings. The first header cell labels the rows and is dropped. */
  columns: string[];
  rows: { label: string; cells: string[] }[];
}

export interface CompanyDetail {
  /** The page this came from, so a figure is checkable. */
  url: string;
  ratios: { name: string; value: string }[];
  pros: string[];
  cons: string[];
  tables: FinTable[];
}

/** Collapses the whitespace screener.in's templates leave everywhere. */
const txt = (node: Element | null | undefined): string =>
  (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Row labels carry a "+" that expands a schedule we are not showing. */
const label = (node: Element | null | undefined): string => txt(node).replace(/\s*\+$/, '');

function parseTable(section: Element | null, id: string): FinTable | null {
  const table = section?.querySelector('table.data-table');
  if (!table) return null;

  const columns = [...table.querySelectorAll('thead th')].map(txt).slice(1);
  const rows = [...table.querySelectorAll('tbody tr')]
    .map((tr) => {
      const cells = [...tr.querySelectorAll('td')];
      return { label: label(cells[0]), cells: cells.slice(1).map(txt) };
    })
    // "Raw PDF" is a row of download buttons on screener.in and arrives here as
    // a label with nothing under it; so does any row whose figures are behind
    // their login. A named row with no numbers tells the reader nothing.
    .filter((r) => r.label !== '' && r.cells.some((c) => c !== ''));

  if (rows.length === 0) return null;
  return {
    id,
    title: txt(section!.querySelector('h2')) || id,
    note: txt(section!.querySelector('p.sub')).replace(/\s*\/\s*View Standalone$/, ''),
    columns,
    rows,
  };
}

export function parseCompany(html: string, url: string): CompanyDetail {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const ratios = [...doc.querySelectorAll('#top-ratios li')]
    .map((li) => ({ name: txt(li.querySelector('.name')), value: txt(li.querySelector('.value')) }))
    // A digit, not just text: screener.in renders the strip for a company it
    // has no figures for, leaving "₹ Cr." and "%" behind. Those are units with
    // nothing in front of them and read as a broken panel — which is what the
    // drawer was showing before `fetchScreenerPage` learned to fall back.
    .filter((r) => r.name !== '' && /\d/.test(r.value));

  const list = (sel: string) => [...doc.querySelectorAll(`${sel} li`)].map(txt).filter(Boolean);

  return {
    url,
    ratios,
    pros: list('#analysis .pros'),
    cons: list('#analysis .cons'),
    tables: TABLE_IDS.map((id) => parseTable(doc.getElementById(id), id)).filter(
      (t): t is FinTable => t !== null,
    ),
  };
}

/**
 * One parse per company per session. The Worker already caches the HTML for six
 * hours, but re-parsing a 240 KB page every time the drawer reopens is work
 * nobody asked for; the numbers behind it are quarterly.
 */
const cache = new Map<string, CompanyDetail>();

export async function fetchCompany(
  security: Pick<Security, 'symbol' | 'bseCode' | 'exchanges'>,
  signal?: AbortSignal,
): Promise<CompanyDetail | null> {
  // Keyed by the path asked for, not the one that answered — see
  // `fetchScreenerPage`, which decides between them from what comes back.
  const [key] = screenerPaths(security);
  if (!key) return null;

  const hit = cache.get(key);
  if (hit) return hit;

  // 404 is a real answer: screener.in has no page under this symbol.
  const page = await fetchScreenerPage(security, signal);
  if (!page) return null;

  const detail = parseCompany(
    page.html,
    `https://www.screener.in${page.path.replace('/api/screener', '')}`,
  );
  cache.set(key, detail);
  return detail;
}
