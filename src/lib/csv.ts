/**
 * Minimal RFC-4180 CSV reader. NSE quotes any company name containing a comma,
 * so a naive split(',') mangles roughly a dozen rows — hence the real parser.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM and normalise line endings; NSE serves CRLF.
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  // Flush the trailing record when the file doesn't end in a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Parses a CSV into objects, trimming header names (NSE pads several with spaces). */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? '').trim();
    });
    return obj;
  });
}

/**
 * One CSV field, quoted only where it has to be.
 *
 * The same three characters the reader above cares about — a comma, a quote or
 * a newline — plus a leading space, which Excel eats. Quoting everything would
 * also be correct and would double the size of a 2,400-row export for nothing.
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of values to CSV text, header row included. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n');
}

/**
 * Hands the browser a file to save, with no server and no dependency.
 *
 * A Blob URL and a synthetic click is the whole of it; the object URL is
 * revoked on the next tick because Chrome cancels the download if it goes too
 * early and leaks the blob if it never goes at all.
 */
export function downloadCsv(filename: string, text: string): void {
  // The BOM is what makes Excel read UTF-8 rather than the system codepage,
  // which is the difference between "Bharat Forge" and mojibake in every
  // company name carrying a rupee sign or an accent.
  const blob = new Blob([`\ufeff${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
