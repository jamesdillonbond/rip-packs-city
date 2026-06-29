# Handoff — Disney Pinnacle hardening (2026-06-29, Cowork)

Pinnacle was audited end-to-end (FMV coverage / freshness / ask pipeline / security / wallet reach). Verdict: **healthier than its "least-hardened" reputation** — `pinnacle_catalog` 2,272 renders, 95.7% priced, 100% art, FMV 96% computed <24h, all 17 Pinnacle pipelines green, the "$1 floor" is genuine (of 323 renders at $1 only 1 is contradicted by real sales). **Five DB migrations shipped + verified live this session. Nothing here is broken** — this is hardening plus one optional, review-gated enhancement left for you.

## Shipped live + verified (revert paths included)

1. **`audit_20260629_pinnacle_render_floor_freshness_sentinel`** — added `v_rpc_trust_health.pinnacle_render_floor_stale_hours` (breach 30h). The render-keyed floor `pinnacle_catalog.floor_ask` (powers ASK_ONLY FMV + every public render/edition/set page; daily writer) had NO freshness sentinel — the existing `pinnacle_ask_stale_hours` (3h) watches the *narrow* `pinnacle_editions.ask` table and stays green while the render floor could silently freeze. **Revert:** `CREATE OR REPLACE VIEW public.v_rpc_trust_health` minus that UNION ALL branch.
2. **`audit_20260629_tombstone_dead_pinnacle_listings_tables`** — `COMMENT ON TABLE` marking `pinnacle_listings_direct` (0 rows, no writer) + `pinnacle_cached_listings` (dead Flowty $1 cache, frozen 06-08) as dead, naming the real ask surfaces. **Revert:** `COMMENT ON TABLE ... IS NULL`.
3. **`audit_20260629_revoke_anon_write_pinnacle_base_tables`** — removed the dormant Supabase anon/authenticated INSERT/UPDATE/DELETE/TRUNCATE grants on 10 Pinnacle base tables (core tables `editions`/`fmv_snapshots`/`sales` were already locked down by the May audit; RLS already denied these — defense-in-depth parity). **Revert:** `GRANT INSERT,UPDATE,DELETE,TRUNCATE ON public.<table> TO anon, authenticated` per table.
4. **`audit_20260629_v_pinnacle_fmv_sanity_flags`** + **`audit_20260629_trust_health_pinnacle_fmv_sanity_metric`** — new `v_pinnacle_fmv_sanity_flags` (service_role, security_invoker) + `pinnacle_fmv_impossible_flags` metric (breach 3). The global `fmv_sanity_flags` is hardcoded to the TopShot collection_id, so render-keyed Pinnacle FMV had freshness monitoring but no correctness monitoring. Measured clean (0 flags). **Revert:** drop the `pinnacle_fmv_impossible_flags` branch from `v_rpc_trust_health` + `DROP VIEW public.v_pinnacle_fmv_sanity_flags`.

End state: `v_rpc_trust_health` = 15 metrics, 0 breaches, 4 Pinnacle sentinels (ask freshness, FMV freshness, render-floor freshness, FMV correctness). `check_public_security_invariants()` + `check_secdef_anon_execute_violations()` both `[]`.

## For you — ONE optional enhancement (LOW priority, pricing-adjacent → review-gated)

**Render-floor intraday freshness.** `pinnacle_catalog.floor_ask` is full-rewritten ONCE DAILY (all rows share one `floor_ask_updated_at`; today ~09:37) by `pinnacle_catalog_set_floor_asks(p_map)`, whose render->price map is built in the `pinnacle-sync` route from the Pinnacle **Studio GraphQL**. Meanwhile `pinnacle-listings-reconcile` runs ~every 15 min but only writes the narrow `pinnacle_editions.ask` (319 editions) — its fresher data never reaches the render-keyed catalog floor that FMV + public pages read. So the public render floor can lag live asks by up to ~24h.

This is a freshness *limitation*, not a bug (daily floor is internally consistent with the daily FMV recompute; Pinnacle is low-velocity). If worth tightening:
- **Option A (route/cron, lowest risk):** add an intraday floor-only `pinnacle-sync` cron tick (same Studio-GraphQL source, just more often). Recommended if pursued.
- **Option B (DB):** derive the render floor from `pinnacle_listing_events` (live on-chain, ~33k rows) and refresh `pinnacle_catalog.floor_ask` intraday. This **changes the floor source** (Studio GraphQL -> on-chain events) = a real pricing-source change; do NOT ship without FMV review.

The new `pinnacle_render_floor_stale_hours` sentinel already guards against the daily writer *stalling*; this is about cadence, not failure.

## Verified clean — do NOT redo
- Art 100% (2,272/2,272 `thumbnail_url`).
- FMV reaches wallets: Pinnacle `wmc` 100% `render_id`, 98.6% `fmv_usd`, 100% `image_url` (137 wallets).
- The 2 NO_DATA-with-ask renders are 1-of-1s with lone $30k/$500k moonshot asks — the writer correctly refuses to ASK_ONLY-price them.
- Pinnacle FMV internally consistent: 0/1270 HIGH/MED renders priced >2x max 90d sale; 0 fmv<=0.

## Skill
The `rpc-data` skill's stale Pinnacle FMV line (`pinnacle_fmv_snapshots` "still live") was corrected (dropped table -> 42P01 footgun; the two ask surfaces; dead listings tables). Repo source synced this commit (`docs/cowork-skills/rpc-data/SKILL.md` + `rpc-data.skill`); Trevor installs the rebuilt `.skill` via Save-skill.
