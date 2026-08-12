# Documentation

Complete walkthrough of the NSE Listed Shares app — what it does, where every byte of data comes from, and exactly what happens between page load and a painted table.

## Reading order

| # | Document | What it covers |
|---|---|---|
| 1 | [Overview & architecture](01-overview.md) | The problem, the two-mode design, the component map, why each library is there |
| 2 | [Data sources](02-data-sources.md) | Every upstream endpoint: URLs, headers, request/response shapes, hard limits, measured results, and the alternatives that were rejected |
| 3 | [Boot flow](03-boot-flow.md) | Step-by-step from `npm run dev` to a painted table, with sequence diagrams and real timings |
| 4 | [Frontend internals](04-frontend.md) | State ownership, the render pipeline, virtualization maths, sorting, search, the detail drawer and chart |
| 5 | [Supabase backend](05-backend-supabase.md) | Schema, RLS, the three Edge Functions, cron scheduling, the candle rotation cursor |
| 6 | [Build from scratch](06-build-from-scratch.md) | Every command and file, from an empty folder to a running app |
| 7 | [Gotchas & debugging](07-gotchas.md) | The failures hit while building this, how each was diagnosed, and how to recognise them again |
| 8 | [Screens](08-screens.md) | Running a Chartink scan clause over the table: the two-phase runner, the request budget, verdicts, and where it differs from Chartink |

## The 30-second version

```
NSE EQUITY_L.csv  ──┐
                    ├──► ingest ──► table (2,397 rows) ──► browser
Yahoo spark/chart ──┘
```

- **2,397** shares listed on the NSE cash market — EQ 2,075 · BE 294 · BZ 28
- **Zero** API keys, accounts, or paid tiers
- **99.96%** price coverage (2,396 of 2,397)
- Runs with `npm install && npm run dev`; Supabase is only needed to deploy

## Conventions used in these docs

- `LTP` — last traded price
- `EQ` / `BE` / `BZ` — NSE settlement series (see [Data sources](02-data-sources.md#series-codes))
- Times marked **measured** were observed on the machine this was built on, not estimated
- File references link to real paths, e.g. [src/lib/directSource.ts](../src/lib/directSource.ts)
