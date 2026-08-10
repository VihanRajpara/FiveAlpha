import { EXCHANGE_LABEL } from '../lib/listings';
import type { Exchange } from '../types';

/**
 * Where a company trades. Rendered as one outlined chip per exchange rather than
 * a single "NSE·BSE" string, so the eye can pick out a row that is missing one
 * without reading the text — which is the whole point of the column, given that
 * ~2,300 of the 5,200 rows carry both.
 */
export function ExchangeBadges({ exchanges }: { exchanges: Exchange[] }) {
  return (
    <span className="exch-cell">
      {exchanges.map((e) => (
        <span key={e} className={`badge exch exch-${e}`} title={EXCHANGE_LABEL[e]}>
          {e}
        </span>
      ))}
    </span>
  );
}
