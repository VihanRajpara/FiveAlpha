import { useEffect, useState } from 'react';
import { fetchCompany, type CompanyDetail } from '../lib/company';
import type { Security } from '../types';

/**
 * The screener.in half of the drawer: ratio strip, pros and cons, and the six
 * financial tables, fetched on open.
 *
 * Below the price and the chart rather than instead of them — those are live
 * Yahoo figures and screener.in's are a daily market cap over quarterly
 * statements, so the two answer different questions and the fresher one leads.
 *
 * The tables are collapsed apart from the first: a company page is a very long
 * document, and a drawer that opens six of them is a scroll bar, not a summary.
 */

/** Rendered open; the rest are one click away. */
const OPEN_BY_DEFAULT = 'quarters';

/**
 * Ratios the drawer already states above, from a fresher source: the live
 * price, and face value off the exchange listing. Printing them twice on one
 * panel reads as two figures that happen to agree.
 */
const ALREADY_SHOWN = new Set(['Current Price', 'Face Value']);

function Table({ table }: { table: CompanyDetail['tables'][number] }) {
  return (
    <details className="fin" open={table.id === OPEN_BY_DEFAULT}>
      <summary>
        {table.title}
        {table.note && <span className="fin-note">{table.note}</span>}
      </summary>
      {/* The label column stays put while the periods scroll — a row of numbers
          with no row name is unreadable, and there are up to thirteen of them. */}
      <div className="fin-scroll">
        <table className="fin-table">
          <thead>
            <tr>
              <th />
              {table.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                <th scope="row">{row.label}</th>
                {row.cells.map((cell, j) => (
                  <td key={j} className="num">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function CompanyFundamentals({ security }: { security: Security }) {
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keyed on the symbol alone: the other two fields fetchCompany reads are
  // fixed for a given symbol, while the `security` object itself is rebuilt on
  // every quote refresh and would re-run this every thirty seconds.
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);

    fetchCompany(security, ac.signal)
      .then((d) => {
        if (ac.signal.aborted) return;
        setDetail(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [security.symbol]);

  if (loading) {
    return (
      <div className="center-msg" style={{ padding: '32px 12px' }}>
        <div className="spinner" />
        Reading screener.in…
      </div>
    );
  }

  if (error) {
    return (
      <div className="center-msg" style={{ padding: '28px 12px' }}>
        Couldn’t read screener.in — {error}
      </div>
    );
  }

  // No page under this symbol is a fact about the company, not a failure.
  if (!detail) {
    return (
      <div className="center-msg" style={{ padding: '28px 12px' }}>
        No screener.in page for {security.symbol}.
      </div>
    );
  }

  const ratios = detail.ratios.filter((r) => !ALREADY_SHOWN.has(r.name));

  return (
    <section className="company">
      {/* Says whose numbers these are before the first of them, rather than in a
          link under the sixth table. */}
      <div className="company-head">
        <h3>Fundamentals</h3>
        <a href={detail.url} target="_blank" rel="noreferrer noopener">
          screener.in ↗
        </a>
      </div>

      {ratios.length > 0 && (
        <dl className="facts">
          {ratios.map((r) => (
            <div className="fact" key={r.name}>
              <dt>{r.name}</dt>
              <dd className="num">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="company-body">
        {(detail.pros.length > 0 || detail.cons.length > 0) && (
          <div className="proscons">
            {detail.pros.length > 0 && (
              <div className="pros">
                <h4>Pros</h4>
                <ul>
                  {detail.pros.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {detail.cons.length > 0 && (
              <div className="cons">
                <h4>Cons</h4>
                <ul>
                  {detail.cons.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="fin-note">Machine generated by screener.in from a checklist.</p>
          </div>
        )}

        {detail.tables.map((t) => (
          <Table key={t.id} table={t} />
        ))}
      </div>
    </section>
  );
}
