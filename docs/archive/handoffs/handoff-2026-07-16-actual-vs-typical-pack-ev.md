# Handoff — surface "Actual EV" vs "Typical Pull EV" on the pack surfaces (2026-07-16)

## Why
Pack EV mean (Actual EV) overstates the typical outcome for lottery-shaped packs: most pulls are commons, a rare grail is the jackpot. Trevor's framing: **Actual EV** swings as grails deplete; **Typical Pull EV** (the median moment you actually pull) sits near the common floor and barely moves. The gap between them is the "grail premium" — how lottery-shaped a pack is. Top Shot shows neither. Live examples:
- Metallic Gold LE Premium (7632): Actual $63.67 / Typical $3.24 -> pure lottery ($60 premium).
- Superstars Collector's (6899): Actual $159.32 / Typical $65.60 -> broadly valuable.
- Grail Seeker (4184): Actual $0.75 / Typical $0.52 -> depleted, both low.

## Already shipped (DB — done, live)
- `compute_pack_ev_per_edition_weighted` returns `typical_pull_ev` (= slots x weighted-MEDIAN moment FMV over the remaining pool) + `typical_per_slot`, beside `gross_ev` (Actual EV = weighted MEAN). Migration `audit_20260716_pack_ev_typical_pull_ev`.
- `pack_ev_history.typical_ev numeric(10,2)` added; exposed through `pack_ev_latest`, `mv_pack_ev_latest`, and `pack_table_rows.typical_ev` (sentinel-nulled like gross_ev). Migration `audit_20260716_expose_typical_ev_in_read_stack`.
- `refresh_atlas_pack_ev()` writes `typical_ev` (hourly pg_cron 189); all 42 Atlas-priced packs carry both now.
- `get_pack_detail_bundle` reads `pack_table_rows`, so `typical_ev` reaches the pack bundle once selected.

## Item 1 — deploy compute-topshot-pack-ev v23 (REQUIRED for full coverage)
Repo is v23 (this commit); only v22 is DEPLOYED. v23 adds `typical_ev: ev.typical_pull_ev` to the pack_ev_history insert so complete non-Atlas (gql) packs also get Typical Pull EV. Deploy via `supabase functions deploy compute-topshot-pack-ev` or MCP `deploy_edge_function`.
**GOTCHA (verified repeatedly 2026-07-16):** MCP/CLI redeploy RESETS `verify_jwt` -> true, which 401s the cron trigger. After deploying, toggle **Verify JWT with legacy secret -> OFF** (Edge Functions > compute-topshot-pack-ev > Settings, Save) and confirm `verify_jwt:false`. Revert = redeploy v22.

## Item 2 — pack page (app/(collections)/[collection]/pack/dist/[distId]/page.tsx)
Both `gross_ev` and `typical_ev` are on the pack row (both NULL when the pool is incomplete/sentinel -> render nothing, same as today's no-EV state).
- Show **Actual EV** = `gross_ev` and **Typical Pull** = `typical_ev`.
- When `typical_ev` < `gross_ev` by a meaningful margin, a "grail premium $X" / "lottery" chip (= gross_ev - typical_ev) communicates the shape. When close, value is evenly spread.
- Keep the existing "vs secondary ask" buy/skip verdict on **Actual EV** (that's the honest expected value); Typical Pull is context, not the verdict.

## Item 3 — /packs board (PackTable.tsx + api/packs/route.ts + PackPageClient.tsx)
- `/api/packs` selects `*` from `pack_table_rows`, so `typical_ev` is already in the payload — just add `typicalEv: r.typical_ev` to the `toPackRow` mapping in `PackPageClient.tsx`.
- Add a "Typical Pull" column to `PackTable` next to EV (or a compact Actual/Typical pair). Optional: a sort on grail premium (`gross_ev - typical_ev`).
- The TS calibrated overlay (`v_topshot_pack_ev_calibrated`) is orthogonal and does NOT carry typical_ev — leave it as-is; don't try to merge (Typical Pull is a remaining-pool stat, calibration is a realized-history correction).

## Definitions (lock in copy)
- **Actual EV** = expected value of a random pull, averaged over remaining sealed moments (weighted mean). Moves as grails get pulled.
- **Typical Pull EV** = value of a typical pull = weighted median moment value x slots. Stable; ~ common floor.
- Both exist only where the remaining pool is complete (Atlas-harvested or genuinely complete); otherwise NULL -> show nothing.
