import { test } from "playwright/test"
import { assertHealthyPage, type PageCheck } from "./healthy-page"

// Rendered-DOM smoke over the PUBLIC (soft-launch un-gated) surfaces. Runs
// against SMOKE_BASE_URL (default https://www.rippackscity.com) — the scheduled
// .github/workflows/e2e-smoke.yml job supplies it. This is a MONITOR, not a
// pull_request gate: it exercises the deployed site, catching the
// "200-but-broken-DOM" class the API smoke gate structurally can't see.
//
// Only enumerate pages that are public per proxy.ts (the 5 published Flow
// collections' read tabs, the /insights hub + a board, /analytics, /pricing,
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

  // Public /insights boards (anon per proxy.ts). The launch-flag-gated boards
  // (panini-squeeze, and candy-mlb until its flag stays flipped) are deliberately
  // omitted so a gating change never reds this monitor.
  { path: "/insights", name: "insights hub" },
  { path: "/insights/top-sales", name: "insights · top sales" },
  { path: "/insights/deals", name: "insights · deals" },
  { path: "/insights/market", name: "insights · market" },
  { path: "/insights/squeeze", name: "insights · squeeze" },
  { path: "/insights/set-completers", name: "insights · set completers" },

  // /analytics dashboard + its public sibling sub-dashboards (the /api/analytics
  // subtree is un-gated). These are the pages whose cold entity/aggregate reads
  // produced the recent pool-acquire-timeout Sentry issues, so a rendered-DOM
  // probe here catches a 200-shell-but-crashed page the API smoke gate can't.
  { path: "/analytics", name: "analytics dashboard" },
  { path: "/analytics/sales", name: "analytics · sales" },
  { path: "/analytics/fmv", name: "analytics · fmv" },
  { path: "/analytics/loans", name: "analytics · loans" },

  { path: "/pricing", name: "pricing" },
]

for (const p of PAGES) {
  test(`smoke: ${p.name} [${p.path}]`, async ({ page }) => {
    await assertHealthyPage(page, p)
  })
}
