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
  { path: "/nba-top-shot/overview", name: "top shot · overview" },
  { path: "/nba-top-shot/market", name: "top shot · market" },
  { path: "/nba-top-shot/sniper", name: "top shot · sniper" },
  { path: "/nfl-all-day/overview", name: "all day · overview" },
  { path: "/laliga-golazos/overview", name: "golazos · overview" },
  { path: "/disney-pinnacle/overview", name: "pinnacle · overview" },
  { path: "/ufc-strike/overview", name: "ufc · overview" },
  { path: "/insights", name: "insights hub" },
  { path: "/insights/top-sales", name: "insights · top sales" },
  { path: "/analytics", name: "analytics dashboard" },
  { path: "/pricing", name: "pricing" },
]

for (const p of PAGES) {
  test(`smoke: ${p.name} [${p.path}]`, async ({ page }) => {
    await assertHealthyPage(page, p)
  })
}
