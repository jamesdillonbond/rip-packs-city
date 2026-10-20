# RPC surface-QA — exhaustive per-surface checklist

This is the *what to check* source of truth. Re-derive live facts (which artifacts exist, which
objects are current) each run — every count and id here is a dated sample, not a constant.

## Part 1 — Artifacts (live dashboards)

**Since 2026-10-20 (#114) the estate is 11 claude.ai artifacts**, ported from the legacy desktop
Cowork store. The URL map is in `docs/reference/known-issues.md` #114; the source of each is
`docs/cowork-skills/<name>.html` (flat, so the helper guard test covers it). `Artifact`
`action:"list"` returns the current set; `action:"read"` with a URL returns the published page.
The legacy desktop copies still exist (only in the desktop sidebar; `list_legacy_live_artifacts`
from a session linked to Trevor's computer) but are superseded — do not refresh them.

The 11: `rpc-qa-scorecard`, `rpc-live-health`, `rpc-deploys-and-cost`, `rpc-my-wallet`,
`rpc-rewards-console`, `candy-chain-two-onboarding-v2`, `rpc-panini-squeeze-v2`,
`rpc-set-challenge-roi`, `rpc-pack-lifecycle`, `rpc-tracked-fmv-confidence`, `rpc-traction`.

For each:

**(a) Stale object references** — flag any of: `topshot_rookies_board` (→ `topshot_2025_rookie_index`),
live-presented `flowty_*` or old `cached_listings` (`cached_listings_v2` is current),
`topshot-listings-indexer` (retired 2026-05-26), any dropped index, any wrong collection UUID, or a
retired function name in an *executed* query. **Verify object existence against the live DB in one
query** (collect every table/view/function the page SQL references, then
`WHERE to_regclass('public.'||n) IS NULL` / `NOT EXISTS (…pg_proc…)`), rather than eyeballing. All
referenced objects existed on 2026-10-20.

**(b) Drifted prose** — live KPIs self-update, but hardcoded narrative numbers/dates/statuses go
stale (e.g. an item marked OPEN that has since shipped). Flag genuine drift.

**(c) Failure handling** — `node scripts/audit-cowork-artifact-failure-handling.mjs docs/cowork-skills`
must report 0 blind, and the helper test must pass. A non-Supabase reader (the two Vercel deploy
readers) must throw on a missing list, never default to `[]`.

**(d) Brand** — RPC red `#E03A2F` accent, uppercase letter-spaced display headers, monospace
numbers. Chart.js/canvas hex literals are the documented allowed exception.

**Refresh only for a genuine inaccuracy:** edit the repo source, publish it with the `Artifact` tool
(the artifact's `url`), `cmp` the published file against the repo copy, commit + ledger. The
long-deferred items were fixed in the 2026-10-20 port — do not re-chase: the `pinnacle_fmv_snapshots`
footer prose (`rpc-live-health`, `rpc-my-wallet`), the `get_wallet_squeeze` label (now
`get_wallet_squeeze_exposure`), the QA scorecard sentinel predicate (fixed 09-25), and the QA
scorecard offer card (retitled "Serial-grain chain bids", informational, never ranked; it no longer
names the dead offers-sweep or claims a self-clear, and throws when its count is missing).

⚠ A first open in a browser waits on a per-connector consent prompt ("Continue"); a QA pass cannot
click it on Trevor's behalf. Report such a page as "not live-verified", not as broken.

## Part 2 — Live pages (Claude in Chrome, www.rippackscity.com)

Console-error-check EVERY page (`read_console_messages`, `onlyErrors`) after it settles. Check desktop
and ~390px (note the resize cap — see the browser doc).

- **Home** — renders the anon front door ("WHAT IS YOUR COLLECTION WORTH?"). If the browser is logged
  in it may 302 to `/dashboard` (expected). Network: `/api/telemetry` POST should be **204** (not a
  302→405 beacon), `/api/track-funnel` 200. No 4xx/5xx beacons.
- **A `/moment/<id>`** — the top-level cross-collection canonical route; `<id>` is an `editions.id`.
  Single-suffixed title, FMV/ask/offer render. (⚠ known Cowork-browser reveal artifact — see browser
  doc; verify against the served HTML, not just the hydrated DOM.)
- **A `/<collection>/edition/<slug>`** — e.g. `/nba-top-shot/edition/124:4493`: Special Serials board +
  Recent Activity, self-canonical (URL-encoded colon), JSON-LD.
- **One `/insights` board** — e.g. `/insights/squeeze`: rows render, not a false-empty, no console error.
- **Dated pack/edition detail surfaces (2026-06-08):**
  - `/nba-top-shot/pack/dist/4184` — "Sales History" with traced purchases + "Packs Content Remaining"
    tier bars + partial-coverage caption; buyer links point at `/analytics/wallets/<addr>`.
  - `/nba-top-shot/pack/dist/901` — Sales History **honest empty state** ("No traced sales yet for this
    pack."), no fake rows.
  - `/nba-top-shot/edition/124:4493` — Special Serials board + Recent Sales.
  - A pin page `/pinnacle/moment/<render_id>` — per-render FMV + floor; title single-suffixed.
- **Pack Sniper** (the only insights surface with a live upstream — Dapper Studio GQL — so most
  break-prone):
  - (a) anon-load `/insights/pack-sniper` — ranked deals render (an honestly-empty gated board is OK;
    an error/spinner is not). High-variance toggle **defaults ON** (`showHighVariance=true`) — packs are
    shown + flagged and the toggle HIDES them. Methodology block present.
  - (b) probe BOTH feed legs as JSON — `/api/public/insights/pack-sniper` and
    `…?collection=nfl-all-day` must each return 200 with `meta.stats` + a `deals` array. (The AllDay
    leg is the no-change control; it 500'd once on a null upstream title.)
  - (c) TS row link shape: View Listing must be the `nbatopshot.com/?packDetail=<distId>` shape
    (updated 2026-07-06). Do NOT flag it as broken or "fix" it back to the old
    `/marketplace/packs/listing/<uuid>/<distId>` shape. A secondary `dapper.market` link must be present.
  - (d) `SELECT count(*) FROM outbound_clicks WHERE surface='pack-sniper'` — report the running total
    (early rows from 2026-06-10 are Cowork verification clicks, not users). 2026-10-17: **7 total, latest
    08-31**, while `alert`/`edition` clicks landed that week. Compare against another surface's recent rows
    before calling a zero a broken beacon.
  - (d2) **Placeholder rows** — in the TS leg's JSON, count deals whose `title` matches `^Pack #\d+$` or
    whose `imageUrl` is empty. Both should be 0. When Dapper sends no `distribution`, the listing carries
    placeholders and `getPackDeals` must fill them from `pack_table_rows` (`liveFields`). 2026-10-17 it was
    30/50 before the fix and 0/50 after. A non-zero count means a stored row is missing or the merge regressed.
  - (e) **Served-HTML crawlability** — fetch the RAW response body (not the hydrated DOM) and count
    `/pack/dist/` drill-down markers. The DOM can show rows while the served HTML has 0 (Finding C: the
    server once hardcoded `includeHighVariance:false` and every matched TS pack was high-variance → an
    empty crawlable table). ISR doesn't vary cache key on query params, so don't chase a cold render —
    establish from served HTML + the AllDay API as control.
- **Console-error check specifics** — hydration #418/#423 ("hydration"/"did not match"; classic cause is
  a timestamp via `toLocaleString` in runtime tz so server-UTC ≠ browser-local); any uncaught exception;
  any repeated 4xx/5xx beacon (a fire-and-forget POST that 302→405 is a real defect even when the page
  looks fine — confirm in DB with a positive control, e.g. authed rows exist while anon rows are zero).
  The DB monitor + night pass are BLIND to this class; live console-reading is the only detector.
- **Mobile** — primary CTAs route to anon-reachable pages (no `/login` bounce at the activation moment),
  Best-offer/FMV cells render, no obvious horizontal overflow.

## Part 3 — Fabricated-data + brand greps (repo)

Run from the connected repo. Flag only NEW violations.

- `grep -rnE "Math\.random|'stub'|'mock'|'fake'" app components lib` (exclude tests/mocks/fixtures).
  **Allowed** (not fabricated data rendered to users): retry/backoff jitter, session-id generation,
  React-key fallbacks (`key={x ?? Math.random()}`), the labelled pack **simulator**
  (`lib/pack-simulator-math.ts`), sampling defaults. Prior fixed landmines to confirm still clean:
  `/api/best-offers`, `lib/trade-escrow/fcl-submit.ts`, the home STATS block.
- `grep -rniE "#E03A2F|Barlow Condensed" app components`. **Allowed exceptions:** OG/opengraph routes,
  email bodies, `global-error.tsx`, recharts `stroke`, `lib/collections.ts` data, `accent_color`/
  `primary_color` data defaults parsed by `hexToRgba`, `theme-color` meta, console-art (`%c` logs),
  SVG/polyline `stroke` props, and any `var(--rpc-red,#E03A2F)` fallback or annotated `brand-exception`
  literal. (Note web red `#E03A2F` vs email red `#E55A4C`.)

## Part 4 — SEO sample

- `app/sitemap.ts` / `/sitemap.xml` — an index of child sitemaps; sum `<loc>` across children. **Dated
  samples, not a target:** 33,423 on 2026-08-27; **~75.2K on 2026-10-17** (9 children, 0–8, all 200;
  children 1–8 = 75,078). The growth is catalogue growth (more collections and editions), not a defect. Flag a
  child that is not 200, or a total that FALLS sharply, not a total above an old sample.
- Spot-check 2–3 entity/insights pages (raw HTML): self-canonical + `application/ld+json` +
  `<meta name="robots" content="index, follow">`. **Home page** was the known gap (no canonical / no
  og:url as of 2026-08-23; canonical shipped by 2026-08-27). **CLOSED 2026-09-25:** the anon home now
  emits both `canonical` and `og:url` (`https://www.rippackscity.com`) — just confirm, do not re-chase.
- `/insights` hub and the footer must both link `/insights/pack-sniper` (it shipped orphaned once).
- Pack Sniper OG = `/api/og/insights/pack-sniper` → `image/png`, non-trivial size (~45 KB).
- For any board claiming server-rendered crawlability, verify the **served HTML** (raw fetch) contains
  the drill-down link markers.
