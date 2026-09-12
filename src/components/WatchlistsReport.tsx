import { useMemo } from 'react';
import type { CapBand, SecurityWithQuote } from '../types';
import type { Watchlist } from '../lib/watchlist';
import {
  buildReport,
  FRESH_BARS,
  type Attention,
  type AttentionKind,
  type Grouped,
} from '../lib/watchlistReport';
import { peekReading, scoreLabel, SIGNAL_FILTER_MAX } from '../lib/signals';
import { CAP_SHORT } from '../lib/classification';
import { formatPercent } from '../lib/format';

/**
 * One page that reads every watchlist at once.
 *
 * The Watchlists section shows one list as a table and is unchanged by this;
 * what it cannot answer is the question you actually have with four lists —
 * which of them is working, what is at risk in any of them, and what is filed
 * in two places. That is a page, not a strip above a table, so it is a section
 * of its own with no filters, no screen bar and no table under it.
 *
 * It is possible here and nowhere else in this app: a signal is one chart
 * request per symbol, so the screener caps bulk reads at `SIGNAL_FILTER_MAX`
 * and every watchlist put together still sits well under it. Nothing new is
 * fetched — the same quotes the table prints, the same UT Bot readings the
 * signal column shows, the same screen the other section filters on.
 *
 * Everything is counted twice on purpose: the roll-up counts each symbol once
 * however many lists hold it, and the per-list cards below count it in each.
 * A symbol in three lists is one holding and three filings, and the page says
 * both rather than picking.
 */

interface Props {
  lists: Watchlist[];
  /** Marked on its card, and the list the star still writes to. */
  activeId: string;
  /** Every list flattened against the market — computed once, in App. */
  grouped: Grouped;
  /** The market by symbol, for the rows the panels link to. */
  bySymbol: Map<string, SecurityWithQuote>;
  matchSymbols: Set<string>;
  /** Bumped by `useSignals` as readings land; recomputes every count here. */
  version: number;
  pending: number;
  /** Whether the lists together are short enough for every chart to be read. */
  affordable: boolean;
  loading: boolean;
  onOpenList: (id: string) => void;
  onSelect: (row: SecurityWithQuote) => void;
}

/** What each attention reason is called, and how it is toned. */
const REASON: Record<AttentionKind, { label: (a: Attention) => string; tone: string }> = {
  stop: { label: () => 'Below stop', tone: 'down' },
  fresh: { label: (a) => `New ${a.side ?? 'signal'}`, tone: '' },
  screen: { label: () => 'At high', tone: 'up' },
  hot: { label: () => 'Stretched', tone: '' },
  cold: { label: () => 'Washed out', tone: '' },
};

const CAP_ORDER: CapBand[] = ['large', 'mid', 'small', 'micro'];

const tone = (n: number | null | undefined): string =>
  n === null || n === undefined || n === 0 ? '' : n > 0 ? 'up' : 'down';

function Tile({
  label,
  value,
  sub,
  valueTone = '',
  title,
}: {
  label: string;
  value: string;
  sub: string;
  valueTone?: string;
  title?: string;
}) {
  return (
    <div className="stat mis-tile" title={title}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value num ${valueTone}`}>{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

/** A row that opens the drawer, with what it is doing and which lists hold it. */
function Row({
  row,
  reason,
  reasonTone = '',
  lists,
  onSelect,
}: {
  row: SecurityWithQuote;
  reason?: string;
  reasonTone?: string;
  lists?: string[];
  onSelect: (row: SecurityWithQuote) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="mis-row"
        onClick={() => onSelect(row)}
        title={`Open ${row.name}`}
      >
        <span className="mis-sym">{row.symbol}</span>
        {lists && lists.length > 0 && (
          <span className="mis-tag" title={lists.join(', ')}>
            {lists.length === 1 ? lists[0] : `${lists[0]} +${lists.length - 1}`}
          </span>
        )}
        {reason && <span className={`mis-reason ${reasonTone}`}>{reason}</span>}
        <span className={`mis-chg num ${tone(row.quote?.changePercent)}`}>
          {formatPercent(row.quote?.changePercent)}
        </span>
      </button>
    </li>
  );
}

export function WatchlistsReport({
  lists,
  activeId,
  grouped,
  bySymbol,
  matchSymbols,
  version,
  pending,
  affordable,
  loading,
  onOpenList,
  onSelect,
}: Props) {
  const { all, perList } = useMemo(
    () => ({
      all: buildReport(grouped.union, peekReading, matchSymbols),
      perList: lists.map((list, i) => ({
        list,
        report: buildReport(grouped.rowsOf[i] ?? [], peekReading, matchSymbols),
      })),
    }),
    // `version` is the dependency that matters: the readings live in a module
    // cache, so nothing about the lists changes when one of them arrives.
    [lists, grouped, matchSymbols, version],
  );

  /** Filed in more than one list — the reason the two sets of counts differ. */
  const shared = useMemo(
    () => [...grouped.memberOf.entries()].filter(([, held]) => held.length > 1),
    [grouped],
  );

  const { memberOf, held, filed } = grouped;
  const signalsShown = affordable && all.read > 0;

  if (held === 0) {
    return (
      <main className="report">
        <div className="center-msg report-empty">
          <strong>Nothing to report yet</strong>
          <span>
            Star a few symbols in the Screener and they will be analysed here — every list on one
            page, whichever one you filed them in.
          </span>
        </div>
      </main>
    );
  }

  return (
    <main className="report">
      <header className="report-head">
        <h2 className="report-title">Watchlist report</h2>
        <p className="report-sub">
          {lists.length} {lists.length === 1 ? 'list' : 'lists'} ·{' '}
          <b className="num">{held.toLocaleString('en-IN')}</b>{' '}
          {held === 1 ? 'symbol' : 'symbols'}
          {filed !== held && <> · {filed.toLocaleString('en-IN')} filings</>}
          {loading
            ? ' · loading the market'
            : !affordable
              ? ` · over ${SIGNAL_FILTER_MAX.toLocaleString('en-IN')}, signals not read`
              : pending > 0
                ? ` · reading ${pending.toLocaleString('en-IN')} charts`
                : ''}
        </p>
      </header>

      <section aria-label="Across every list">
        <div className="mis-tiles">
          <Tile
            label="Day move"
            value={formatPercent(all.avgChangePct)}
            valueTone={tone(all.avgChangePct)}
            sub={`equal weight · ${all.priced} of ${held} priced`}
            title="The mean day change across every symbol you hold, counted once however many lists hold it. Equal-weighted: no quantities are stored, so no other weighting would be honest."
          />
          <Tile
            label="Stance"
            value={signalsShown ? `${all.buy} / ${all.sell}` : '—'}
            sub={signalsShown ? `buy / sell · ${all.quiet} quiet` : 'not read'}
            title="UT Bot's latest flip per symbol, over two years of daily bars. Quiet means the rule has not flipped inside that window."
          />
          <Tile
            label="Fresh flips"
            value={signalsShown ? String(all.fresh) : '—'}
            sub={`within ${FRESH_BARS} sessions`}
            title="Signals that fired in the last five trading sessions — the ones that are still news."
          />
          <Tile
            label="Below stop"
            value={signalsShown ? String(all.belowStop) : '—'}
            valueTone={all.belowStop > 0 ? 'down' : ''}
            sub="trailing stop crossed"
            title="Price has already crossed back through the trailing stop, so the current signal is about to be replaced."
          />
          <Tile
            label="Momentum"
            value={signalsShown ? `${all.overbought} / ${all.oversold}` : '—'}
            sub="MAPO ≥80 / ≤20"
            title="How much of the moving-average fan the close sits above. Above 80 is stretched, below 20 is washed out."
          />
          <Tile
            label="Quality"
            value={all.avgScore === null ? '—' : String(Math.round(all.avgScore))}
            sub={all.avgScore === null ? 'not read' : `avg score · ${scoreLabel(all.avgScore)}`}
            title="The mean signal score across everything you hold, 0–100. Context only — it never moves a signal's side."
          />
          <Tile
            label="At high"
            value={String(all.matches)}
            sub="on the screen today"
            title="How many of your symbols the all-time-high breakout screen currently matches."
          />
        </div>
      </section>

      <section aria-label="By list">
        <h3 className="report-h">By list</h3>
        <div className="report-lists">
          {perList.map(({ list, report }) => (
            <button
              key={list.id}
              type="button"
              className="lcard"
              onClick={() => onOpenList(list.id)}
              title={`Open ${list.name} in Watchlists`}
            >
              <span className="lcard-head">
                <span className="lcard-name">{list.name}</span>
                {list.id === activeId && <span className="lcard-badge">Active</span>}
              </span>

              {report.count === 0 ? (
                <span className="mis-empty">Empty — nothing filed here yet.</span>
              ) : (
                <>
                  <span className={`lcard-move num ${tone(report.avgChangePct)}`}>
                    {formatPercent(report.avgChangePct)}
                  </span>
                  <span className="lcard-meta num">
                    {report.count} {report.count === 1 ? 'symbol' : 'symbols'} · {report.up}↑{' '}
                    {report.down}↓
                  </span>
                  <span className="lcard-figs">
                    <span>
                      <i>Stance</i>
                      <b className="num">
                        {signalsShown ? `${report.buy}/${report.sell}` : '—'}
                      </b>
                    </span>
                    <span>
                      <i>Fresh</i>
                      <b className="num">{signalsShown ? report.fresh : '—'}</b>
                    </span>
                    <span>
                      <i>Below stop</i>
                      <b className={`num ${report.belowStop > 0 ? 'down' : ''}`}>
                        {signalsShown ? report.belowStop : '—'}
                      </b>
                    </span>
                    <span>
                      <i>At high</i>
                      <b className="num">{report.matches}</b>
                    </span>
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Across every list, in detail">
        <h3 className="report-h">Across every list</h3>
        <div className="mis-panels">
          <section className="mis-panel" aria-label="Rows worth opening">
            <h4 className="mis-panel-title">Needs a look</h4>
            {all.attention.length === 0 ? (
              <p className="mis-empty">
                {signalsShown
                  ? 'Nothing crossed a stop, flipped or reached a high today.'
                  : 'Signals not read for these lists.'}
              </p>
            ) : (
              <ul className="mis-list">
                {all.attention.map((item) => (
                  <Row
                    key={item.row.symbol}
                    row={item.row}
                    reason={REASON[item.kind].label(item)}
                    reasonTone={REASON[item.kind].tone}
                    lists={memberOf.get(item.row.symbol)}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="mis-panel" aria-label="Today's movers">
            <h4 className="mis-panel-title">Movers</h4>
            <div className="mis-movers">
              <div className="mis-movers-col">
                <h5 className="mis-sub">Up</h5>
                {all.gainers.length === 0 ? (
                  <p className="mis-empty">None today.</p>
                ) : (
                  <ul className="mis-list">
                    {all.gainers.map((row) => (
                      <Row key={row.symbol} row={row} onSelect={onSelect} />
                    ))}
                  </ul>
                )}
              </div>
              <div className="mis-movers-col">
                <h5 className="mis-sub">Down</h5>
                {all.losers.length === 0 ? (
                  <p className="mis-empty">None today.</p>
                ) : (
                  <ul className="mis-list">
                    {all.losers.map((row) => (
                      <Row key={row.symbol} row={row} onSelect={onSelect} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section className="mis-panel" aria-label="Symbols in more than one list">
            <h4 className="mis-panel-title">In more than one list</h4>
            {shared.length === 0 ? (
              <p className="mis-empty">Every symbol is filed once.</p>
            ) : (
              <ul className="mis-list">
                {shared.slice(0, 6).map(([symbol, held]) => {
                  const row = bySymbol.get(symbol);
                  return row ? (
                    <Row key={symbol} row={row} lists={held} onSelect={onSelect} />
                  ) : (
                    <li key={symbol}>
                      <span className="mis-row">
                        <span className="mis-sym">{symbol}</span>
                        <span className="mis-tag">{held.join(', ')}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </section>

      <div className="mis-comp">
        {CAP_ORDER.filter((band) => all.cap[band] > 0).map((band) => (
          <span key={band} className="pill">
            {CAP_SHORT[band]} <b className="num">{all.cap[band]}</b>
          </span>
        ))}
        {all.fno > 0 && (
          <span className="pill">
            F&amp;O <b className="num">{all.fno}</b>
          </span>
        )}
      </div>
    </main>
  );
}
