# RPC Surface QA — 2026-08-23 (Claude Code run, real-browser)

Run of the `rpc-surface-qa` checklist from **Claude Code on Trevor's Windows box**, one day after the
2026-08-22 Cowork run. Not the weekly cadence — an interactive run requested to close the coverage gaps
the Cowork environment cannot reach.

**Status: AMBER.** Three real defects found, all new, none previously known. Everything the 08-22 run
checked stayed green. The three findings are packaged in
[handoff-2026-08-23-anon-telemetry-405-home-canonical-sniper-ssr.md](handoff-2026-08-23-anon-telemetry-405-home-canonical-sniper-ssr.md).

## Why this run found things the weekly one could not

Two capability differences, both of which produced a finding:

1. **Served HTML read separately from the hydrated DOM.** Cowork reads the rendered page; this run
   fetched the raw response body and counted markers in it. That is the only way Finding C was visible —
   the browser view looks correct while the crawlable HTML is empty.
2. **A true 390px viewport.** Cowork's `resize_window` bottoms out at a 738px CSS viewport (Chrome's
   minimum window width). Playwright sets the viewport directly, so the sub-420 phone layer that the
   08-22 report explicitly listed as a residual gap is now actually measured.

## Findings (all handed off, nothing shipped)

| # | Finding | Severity | Surface |
|---|---|---|---|
| A | Every anonymous telemetry beacon 405s — `POST /api/telemetry` is 302'd to `/login` by `proxy.ts`. Zero `anon` rows in `usage_events` in a full month, against a 306-row authed positive control. | P1 | `proxy.ts` |
| B | Home page emits no `<link rel="canonical">` and no `og:url`; every other page has one. | P2 | `lib/seo.ts` / `app/page.tsx` |
| C | Pack Sniper's server HTML contains **0** `/pack/dist/` links — the server hardcodes `includeHighVariance: false` while all 84 matched TS packs are high-variance, so the crawlable table is empty. | P2 | `app/insights/pack-sniper/page.tsx` |

Finding C is the same bug the 2026-07-09 reconciliation fixed on the client; the server half was never
updated, and the client fix masked it.

## Part 1 — Artifacts

**Not run.** Artifact tooling (`update_artifact` / `list_artifacts`) is Cowork-only and unreachable from
Claude Code. The 08-22 run audited all 11 live artifacts and DB-verified 63 relations + 2 functions;
nothing in this run contradicts it. The two known-deferred prose footers stay deferred.

## Part 2 — Live pages (real browser, desktop 1440 + mobile 390)

Nine page loads at each viewport. **Zero React #418/#423, zero hydration errors, zero uncaught
exceptions.** The only console error anywhere was the 405 from Finding A — present on every page.

| page | desktop | 390px | notes |
|---|---|---|---|
| `/` (anon) | 200 | 200 | no canonical (Finding B) |
| `/moment/<id>` | 200 | 200 | 1 transient degraded render in 6; copy is honest, `noindex,follow` |
| `/nba-top-shot/edition/124:4493` | 200 | 200 | Cam Reddish, Value $0.26, Special Serials + Recent Sales present |
| `/pinnacle/moment/LEEV1-D23-GROG-E6` | 200 | 200 | Grogu · Radiant Chrome, per-render FMV + Product JSON-LD, title single-suffixed |
| `/insights` | 200 | 200 | links pack-sniper in body **and** footer |
| `/insights/serial-premiums` | 200 | 200 | live-degraded, reporting honestly (see below) |
| `/insights/pack-sniper` | 200 | 200 | 84 rows in DOM, 0 in HTML (Finding C) |
| `/nba-top-shot/pack/dist/4184` | 200 | 200 | Sales History ✓ · Packs Content Remaining ✓ · partial-coverage caption ✓ · 20 buyer links → `/analytics/wallets/0x…` ✓ |
| `/nba-top-shot/pack/dist/901` | 200 | 200 | honest empty state: "No traced sales yet for this pack", no fabricated `$0.00` rows ✓ |

**Mobile: `scrollWidth − innerWidth` = 0px on every page at a true 390px viewport.** No horizontal
overflow anywhere. This closes the residual gap the 08-22 report flagged.

### Pack Sniper

- Both feed legs **200** with `meta.stats` + a deals array. TS: `matched=84, positiveEv=4`.
  All Day: `matched=95, positiveEv=17`. The 2026-06-10 null-upstream-title 500 class has **not** regressed.
- High-variance toggle **defaults ON** (`checked: true`, labelled "HIGH-VARIANCE PACKS") ✓ — matches the
  2026-07-09 reconciliation.
- Methodology block present ✓.
- TS row `buyUrl` = `https://nbatopshot.com/?packDetail=7698` ✓ — correct `packDetail` shape, not the
  retired listing path. Secondary `dapper.market` link present ✓ (84 of them).
- `outbound_clicks WHERE surface='pack-sniper'` = **5** (all-time across all surfaces: 59). Unchanged
  from 08-22 — still the early Cowork verification clicks, no user traffic.

### Honest-degradation observations

Two independent degraded renders were caught live, and **both behaved correctly** — worth recording
because this is the platform's most-watched defect class:

- `/moment/<id>` once rendered `MomentUnavailableCard`: *"This moment didn't load … This says nothing
  about whether the moment exists — only that we couldn't read it."* with `robots: noindex, follow`.
  Deliberately not a 404. 5/5 clean on re-probe.
- `/insights/serial-premiums` is **currently degraded** — `PARTIAL DATA · 1 of 1 section could not be
  loaded (Serial premiums)`, 0 rows, explicitly told to treat as unknown rather than zero. Consistent
  with the known disk-IO saturation.

## Part 3 — Fabricated-data + brand greps

**Clean.** No new violations.

- **`Math.random`** — 17 hits across `app/`, `components/`, `lib/`. All are retry jitter, session ids,
  the pack-simulator RNG, the verify-challenge cents, or React-key fallbacks. None fabricates user-facing
  data. Prior landmines (`/api/best-offers`, `lib/trade-escrow/fcl-submit.ts`, the home STATS block) stay
  fixed.
- **`lib/schonely.ts`** — the random loading/empty phrases were checked specifically for hydration
  exposure, since random text picked during render is the classic #418 shape. All four call sites are
  **unreachable on first paint**, verified against each one's initial state: `InsiderSignalsPanel` and
  `FastBreakClient` render loading branches first (`alerts === null` / `loading === true`);
  `CollectionTabClient`'s `loading`/`loadingMore` both init `false`; `CollectionAnalyticsClient`'s
  `pickEmpty()` sits behind a non-empty `playerQuery`. No exposure.
- **`stub` / `mock` / `fake`** — every hit is a comment documenting anti-fabrication work. The one live
  synthetic (`/api/profile/hero-moment`) is gated behind a constant-time match on
  `SMOKE_TEST_SESSION_TOKEN` and tagged `isSmokeTestStub: true`.
- **Brand** — all `#E03A2F` / `Barlow Condensed` hits fall in documented exceptions: email HTML bodies,
  SVG `stroke` attributes, `hexToRgba` inputs, `accent_color` data defaults, recharts strokes, a styled
  `console.log`, `theme-color` meta, and `var(--rpc-red,#E03A2F)` / `var(--font-display,'Barlow Condensed')`
  fallbacks.

## Part 4 — SEO

- **Sitemap: 33,307 URLs** across 5 children, index 200, every child 200.
  `0.xml` 116 · `1.xml` 13,241 · `2.xml` 7,283 · `3.xml` 4,589 · `4.xml` 8,078. (~33K ✓, +38 vs 08-22.)
- **Liveness sample** — 5 entity URLs pulled from segment 3 at spread offsets, spanning moment / set /
  player / team across Top Shot and All Day: **5/5 → 200.** No dead entries.
- **Canonical / robots / JSON-LD** — correct on every page checked except home (Finding B). All boards
  carry `robots: index, follow` and `WebApplication` JSON-LD; the Pinnacle pin page adds `Product`.
- **OG** — `/api/og/insights/pack-sniper` → 200, `image/png`, **45,899 bytes** (unchanged from 08-22).
- **Orphan check** — `/insights/pack-sniper` is linked from both the `/insights` hub body and the
  global footer ✓.

## Task-file amendments to apply via `update_scheduled_task`

The Cowork task prompt could not be edited from here (it lives in the Cowork scheduler, not the repo —
per `docs/operations/qa-loop.md`, task prompts are changed with `update_scheduled_task`, not by editing
files). Two checks earned their place this run and should be added:

1. **Read the served HTML, not just the DOM.** For any board whose page comment claims server-rendered
   crawlability, fetch the raw response and count the drill-down link marker. Finding C is invisible to
   every browser-based check.
2. **Watch the console for a 405/4xx beacon, not only for React errors.** The task currently names
   hydration errors specifically; Finding A was a silent 405 on every page load that the existing
   phrasing does not ask anyone to notice.

Both fixtures from the 08-22 amendments held: `dist/4184` still demonstrates Sales History (16,853
traced purchases) and `dist/901` still renders the honest empty state.

## Not covered this run

- **Part 1 artifacts** — Cowork-only tooling.
- **Cold-render behaviour of `/insights/pack-sniper`** — ISR does not vary its cache key on query
  params, so a cold SSR render could not be forced; all repeat probes were CDN `HIT`s with a climbing
  `age`. Finding C was instead established from the API A/B plus the AllDay control, which does not
  depend on catching a cold render.
