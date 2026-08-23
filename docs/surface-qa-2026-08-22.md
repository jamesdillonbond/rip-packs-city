# RPC Surface QA — 2026-08-22 (expanded sweep)

Run of the weekly `rpc-surface-qa` task, extended interactively to close every coverage gap.
**Status: GREEN.** No console/hydration errors, no fabricated data, no brand violations, no stale
artifact refs, no dead sitemap URLs, no broken OG cards. Two stale items in the task file itself
were found and fixed (see bottom).

> Note: this file was written to the working tree by the Cowork QA run; it is **not committed**.
> Commit/push at your discretion (docs-only; won't trigger a Vercel rebuild).

## Part 1 — Artifacts (all 11 live artifacts, not just the task list)
Read every live artifact and **DB-verified every embedded object reference** (63 relations +
2 functions — all exist). No live query references a dropped/renamed object.
- QA-list (5 exist): rpc-live-health, rpc-my-wallet, rpc-qa-scorecard, rpc-traction, rpc-deploys-and-cost.
  The other 9 QA-list ids were retired/folded (e.g. rpc-fmv-watch + rpc-insights-health → rpc-live-health).
- Additionally audited the 6 non-list live artifacts: rpc-tracked-fmv-confidence, rpc-pack-lifecycle,
  rpc-set-challenge-roi, rpc-rewards-console, rpc-panini-squeeze-v2, candy-chain-two-onboarding-v2.
- `pinnacle_fmv_snapshots` + `topshot_rookies_board` confirmed dropped but appear only in the two
  known-deferred prose footers (rpc-live-health L240, rpc-my-wallet L142) — left untouched per instruction.
- Brand consistent (shared dark-theme + `var(--rpc-red)` token block). **Nothing needed refreshing.**

## Part 2 — Live pages (all rendered clean, zero console errors)
home (anon, footer links pack-sniper), a /moment, edition 124:4493 (Activity/Sales board with real rows),
a /pinnacle/moment render (per-render FMV $203 + floor $225 + serial-premium model, single-suffixed title),
dist/901, dist/4184, and Pack Sniper. No React #418/#423 anywhere.
- **Pack Sniper feed legs both healthy:** TS 200 (matched 84 / positiveEv 6), AllDay 200
  (matched 159 / positiveEv 24) — the null-title 500 class has NOT regressed. Toggle defaults ON,
  methodology present, TS `buyUrl` = `nbatopshot.com/?packDetail=` + dapper.market secondary.
- Observed the **honest degradation path** live: a transient DB-load blip produced a
  "PARTIAL DATA … treat as unknown rather than zero" banner with dashes, not fabricated zeros.
- **dist/7800 fixture drift:** distId 7800 now resolves to a free Reward pack (0 traced sales),
  so it can't demonstrate Sales History. Verified replacement **dist/4184 "Grail Seeker"**
  (16,853 traced purchases; Top/Recent purchases tables; 20 buyer links → /analytics/wallets/0x…).
  dist/901 remains the correct empty-state fixture ("No traced sales yet for this pack").

## Part 3 — Fabricated-data + brand greps
All `Math.random` uses are jitter / React-key fallbacks / session-ids / the pack-simulator RNG /
verify-challenge cents — none fabricate user data. Prior landmines (best-offers, trade-escrow/fcl-submit,
home stats) stay clean. All `#E03A2F` / `Barlow Condensed` hits are documented exceptions (OG routes,
email bodies, recharts strokes, SVG sparklines, `theme-color` meta, profile accent-color data defaults,
admin clients, `var(--rpc-red,#E03A2F)` fallbacks, a styled console.log). No new violations.

## Part 4 — SEO (expanded well beyond the 2–3 sample)
- **Sitemap:** index → 5 children summing to **33,269 URLs** (~33K ✓).
- **16 insights boards** all checked (11 Flow/Pinnacle + candy-mlb + panini-squeeze + parallel-premiums
  discovered in the sitemap): each self-canonical, `robots: index, follow`, JSON-LD WebApplication,
  zero console errors, no horizontal overflow.
- **OG sweep:** all 15 `/api/og/insights/*` endpoints return 200 + image/png (pack-sniper 45.9 KB).
- **Sitemap liveness:** 11 sampled URLs (static, legal, insights, collection surfaces, and entity pages
  spanning moment/player/team across all collections) all resolve **200** — no dead entries.
- /insights hub AND footer both link /insights/pack-sniper.

## Mobile
`resize_window` bottoms out at a **738px CSS viewport** (Chrome min-window-width — a hard limit, confirming
the task caveat). 738px is below the 768 breakpoint (mobile CSS active); measured `scrollWidth − innerWidth`
= −12…−15px on every board → **no horizontal overflow**. Residual gap: the true sub-420 phone layer is not
reachable with these tools.

## Outbound clicks
`outbound_clicks WHERE surface='pack-sniper'` = **5** (early Cowork verification clicks); 59 all-time.

## Task-file fixes applied this run (via update_scheduled_task; backup in outputs/)
1. Part 2 fixture: `/nba-top-shot/pack/dist/7800` → `/nba-top-shot/pack/dist/4184`.
2. Part 1 artifact path: `C:\Users\TDill\OneDrive\Documents\Claude\Artifacts\` →
   `C:\Users\TDill\Claude\Artifacts\` (authoritative per list_artifacts; OneDrive path was stale).

## Handoffs
None — no route/.tsx/worker code changes needed. Clean week.
