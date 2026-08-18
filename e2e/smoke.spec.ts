import { test } from "playwright/test"
import { assertHealthyPage, type PageCheck } from "./healthy-page"

// Rendered-DOM smoke over the PUBLIC (soft-launch un-gated) surfaces. Runs
// against SMOKE_BASE_URL (default https://www.rippackscity.com) — the scheduled
// .github/workflows/e2e-smoke.yml job supplies it. This is a MONITOR, not a
// pull_request gate: it exercises the deployed site, catching the
// "200-but-broken-DOM" class the API smoke gate structurally can't see.
//
// Only enumerate pages that are public per proxy.ts (the 5 published Flow
// collections' read tabs, the /insights hub + every un-flagged board, /pricing,
// and the marketing home). Personalized/gated routes are intentionally omitted.

const PAGES: PageCheck[] = [
  { path: "/", name: "marketing home", expectText: /Rip Packs City|collectibles|Flow/i },

  // Per-collection read tabs. Each collection is enumerated across the tabs its
  // registry entry lists (market is not on UFC; sets is not on Pinnacle), so the
  // monitor exercises each collection's DISTINCT data plumbing — Disney Pinnacle
  // in particular runs on a separate table/data plane (pinnacle_editions /
  // pinnacle_fmv_history) that the shared [collection] route does not touch, so
  // its tabs must be probed on their own.
  { path: "/nba-top-shot/overview", name: "top shot · overview" },
  { path: "/nba-top-shot/collection", name: "top shot · collection" },
  { path: "/nba-top-shot/market", name: "top shot · market" },
  { path: "/nba-top-shot/sniper", name: "top shot · sniper" },
  { path: "/nba-top-shot/sets", name: "top shot · sets" },
  { path: "/nba-top-shot/analytics", name: "top shot · analytics" },

  { path: "/nfl-all-day/overview", name: "all day · overview" },
  { path: "/nfl-all-day/market", name: "all day · market" },
  { path: "/nfl-all-day/sniper", name: "all day · sniper" },
  { path: "/nfl-all-day/analytics", name: "all day · analytics" },

  { path: "/laliga-golazos/overview", name: "golazos · overview" },
  { path: "/laliga-golazos/market", name: "golazos · market" },
  { path: "/laliga-golazos/sniper", name: "golazos · sniper" },
  { path: "/laliga-golazos/analytics", name: "golazos · analytics" },

  { path: "/disney-pinnacle/overview", name: "pinnacle · overview" },
  { path: "/disney-pinnacle/market", name: "pinnacle · market" },
  { path: "/disney-pinnacle/sniper", name: "pinnacle · sniper" },
  { path: "/disney-pinnacle/analytics", name: "pinnacle · analytics" },

  { path: "/ufc-strike/overview", name: "ufc · overview" },
  { path: "/ufc-strike/sniper", name: "ufc · sniper" },
  { path: "/ufc-strike/sets", name: "ufc · sets" },
  { path: "/ufc-strike/analytics", name: "ufc · analytics" },

  // Public /insights boards — the set is DERIVED, not curated: proxy.ts opens
  // `/insights/*` to anon, minus `panini-*` / `candy-*` while their launch flags
  // are off. ⚠ BOTH FLAGS ARE `true` IN lib/launch-flags.ts (checked 2026-08-17),
  // so those two boards ARE public and are listed here. The previous version of
  // this comment said they were "deliberately omitted... until its flag stays
  // flipped" — that had been stale since the launches, and it is exactly how two
  // live public boards sat outside the only monitor that can see them.
  //
  // ⚠ THIS LIST WAS 5 BOARDS OUT OF 30 UNTIL 2026-08-17, AND THE TWO INCIDENTS
  // THIS MONITOR EXISTS FOR BOTH LANDED ON BOARDS. `/insights/first-mint` threw
  // React #418 on every load for an unknown period, and `/insights/top-sales`
  // threw it intermittently — this file's own console assertion is the ONLY
  // detector for that class (vitest renders both sides in one UTC process, so it
  // is unreachable there by construction), and neither page was in the sweep.
  // The same 25 boards are also where the "a slow prerender fails the whole
  // production build" class lives. Coverage of the class was 1-in-6.
  //
  // ⚠ THE 23 ADDED HERE WERE NOT PROBED FIRST — the sandbox that added them has
  // no egress to production (the agent proxy rejects the connect), so the first
  // scheduled run is their validation. Stated rather than implied, because this
  // file's other big comment is about a cry-wolf entry: if one of these fails,
  // TRIAGE IT, do not delete the line. These are unconditionally public, so a
  // failure here is a true positive — unlike the /analytics case below, which
  // was structurally red forever because those routes 302 to /login.
  //
  // __tests__/e2e-smoke-covers-public-insights-boards.test.ts keeps this list
  // complete by DERIVING the population from app/insights/* + proxy.ts, so the
  // next board cannot ship outside the monitor the way these 23 did.
  { path: "/insights", name: "insights hub" },
  { path: "/insights/top-sales", name: "insights · top sales" },
  { path: "/insights/deals", name: "insights · deals" },
  { path: "/insights/market", name: "insights · market" },
  { path: "/insights/squeeze", name: "insights · squeeze" },
  { path: "/insights/set-completers", name: "insights · set completers" },
  { path: "/insights/account-value", name: "insights · account value" },
  { path: "/insights/allday-pack-market", name: "insights · all day pack market" },
  { path: "/insights/allday-pack-reality", name: "insights · all day pack reality" },
  { path: "/insights/allday-scarcity", name: "insights · all day scarcity" },
  { path: "/insights/cross-collection", name: "insights · cross collection" },
  { path: "/insights/first-mint", name: "insights · first mint" },
  { path: "/insights/market-pulse", name: "insights · market pulse" },
  { path: "/insights/new-collectors", name: "insights · new collectors" },
  { path: "/insights/offer-spread", name: "insights · offer spread" },
  { path: "/insights/pack-drops", name: "insights · pack drops" },
  { path: "/insights/pack-reality", name: "insights · pack reality" },
  { path: "/insights/pack-sniper", name: "insights · pack sniper" },
  { path: "/insights/parallel-premiums", name: "insights · parallel premiums" },
  { path: "/insights/pinnacle-scarcity", name: "insights · pinnacle scarcity" },
  { path: "/insights/rookie-board", name: "insights · rookie board" },
  { path: "/insights/rookies", name: "insights · rookies" },
  { path: "/insights/serial-premiums", name: "insights · serial premiums" },
  { path: "/insights/set-squeeze", name: "insights · set squeeze" },
  { path: "/insights/squeeze-check", name: "insights · squeeze check" },
  { path: "/insights/tc-report", name: "insights · tc report" },
  { path: "/insights/topshot-pack-market", name: "insights · top shot pack market" },
  { path: "/insights/trophies", name: "insights · trophies" },
  { path: "/insights/underpriced-serials", name: "insights · underpriced serials" },
  { path: "/insights/panini-squeeze", name: "insights · panini squeeze" },
  { path: "/insights/candy-mlb", name: "insights · candy mlb" },

  // ⚠ DO NOT ADD the top-level /analytics dashboards here (2026-08-02).
  // /analytics, /analytics/sales, /analytics/fmv and /analytics/loans were
  // listed as public and made this monitor RED on every run from the day it was
  // created (4/4 failures, "rendered only 0 chars"). They are NOT public:
  // proxy.ts gates them explicitly — see its own comment, "the in-app feature
  // pages (/collection, /sniper, /sets, /market, /packs, /analytics) stay behind
  // the funnel". What IS un-gated is (a) the /api/analytics API subtree and
  // (b) the PER-COLLECTION tab /{slug}/analytics — both already covered above.
  // Anonymous, those four 302 to /login, which the browser follows to a
  // client-rendered shell with an empty server body, hence 0 chars.
  //
  // This is the documented anon-audit trap: a plain fetch follows the redirect
  // and reports HTTP 200 with the ~21,350-byte /login body, so the route looks
  // fine to any status-only check. Verified live 2026-08-02: /analytics and
  // /analytics/sales both return exactly 21,350 bytes (the /login page), while
  // a genuinely public board (/insights/serial-premiums) returns 215,431.
  //
  // A gate that cries wolf gets ignored — and this is the ONLY gate that catches
  // the 200-but-broken-DOM class. To cover these pages, the spec needs an
  // authenticated browser context, not another entry in this public list.

  { path: "/pricing", name: "pricing" },
]

for (const p of PAGES) {
  test(`smoke: ${p.name} [${p.path}]`, async ({ page }) => {
    await assertHealthyPage(page, p)
  })
}
