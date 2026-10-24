import { useEffect } from 'react';
import { Icon } from './Icon';

/**
 * Any address but the front page.
 *
 * The app is one screen, and the Worker answers every unknown path with it
 * (`not_found_handling` in wrangler.toml) — so without this a mistyped link
 * opened a full screener at a URL that does not exist, and a bookmark of it
 * would go on working by accident. This says what happened and goes home.
 */
export function NotFound({ path }: { path: string }) {
  useEffect(() => {
    document.title = 'Page not found · FiveAlpha';
  }, []);

  return (
    <main className="notfound">
      <div className="notfound-card">
        <div className="brand-logo notfound-mark" role="img" aria-label="FiveAlpha" />
        <p className="notfound-code" aria-hidden>
          404
        </p>
        <h1 className="notfound-title">There’s no page at this address</h1>
        <p className="notfound-body">
          FiveAlpha is a single screen. The screener, your watchlists and every company’s chart
          open from the front page, so <code>{path}</code> doesn’t lead anywhere.
        </p>
        <a className="btn notfound-home" href="/">
          Open the screener
          <Icon name="chevronRight" size={16} weight={2} />
        </a>
      </div>
    </main>
  );
}
