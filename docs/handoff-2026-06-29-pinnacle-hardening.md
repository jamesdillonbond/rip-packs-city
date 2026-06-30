# Handoff — Disney Pinnacle hardening (2026-06-29, Cowork)

Pinnacle was audited end-to-end (FMV coverage / freshness / ask pipeline / security / wallet reach). Verdict: **healthier than its "least-hardened" reputation** — `pinnacle_catalog` 2,272 renders, 95.7% priced, 100% art, FMV 96% computed <24h, all 17 Pinnacle pipelines green, the "$1 floor" is genuine (of 323 renders at $1 only 1 is contradicted by real sales). **Five DB migrations shipped + verified live this session. Nothing here is broken** — this is hardening plus one optional, review-gated enhancement left for you.

## Shipped live + verified (revert paths included)

1. **`audit_20260629_pinnacle_render_floor_freshness_sentinel`** — added `v_rpc_trust_health.pinnacle_render_floor_stale_hours` (breach 30h). The render-keyed floor `pinnacle_catalog.floor_ask` (powers ASK_ONLY FMV + every public render/edition/set page; daily writer) had NO freshness sentinel — the existing `pinnacle_ask_stale_hours` (3h) watches the *narrow* `pinnacle_editions.ask` table and stays green while the render floor could silently freeze. **Revert:** `CREATE OR REPLACE VIEW public.v_rpc_trust_health` minus that UNION ALL branch.
2. **`audit_20260629_tombstone_dead_pinnacle_listings_tables`** — `COMMENT ON TABLE` marking `pinnacle_listings_direct` (0 rows, no writer) + `pinnacle_cached_listings` (dead Flowty $1 cache, frozen 06-08) as dead, naming the real ask surfaces. **Revert:** `COMMENT ON TABLE ... IS NULL`.
3. **`audit_20260629_revoke_anon_write_pinnacle_base_tables`** — removed the dormant Supabase anon/authenticated INSERT/UPDATE/DELETE/TRUNCATE grants on 10 Pinnacle base tables (core tables `editions`/`fmv_snapshots`/`sales` were already locked down by the May audit; RLS already denied these — defense-in-depth parity). **Revert:** `GRANT INSERT,UPDATE,DELETE,TRUNCATE ON public.<table> TO anon, authenticated` per table.
4. **`audit_20260629_v_pinnacle_fmv_sanity_flags`** + **`audit_20260629_trust_health_pinnacle_fmv_sanity_metric`** — new `v_pinnacle_fmv_sanity_flags` (service_role, security_invoker) + `pinnacle_fmv_impossible_flags` metric (breach 3). The global `fmv_sanity_flags` is hardcoded to the TopShot collection_id, so render-keyed Pinnacle FMV had freshness monitoring but no correctness monitoring. Measured clean (0 flags). **Revert:** drop the `pinnacle_fmv_impossible_flags` branch from `v_rpc_trust_health` + `DROP VIEW public.v_pinnacle_fmv_sanity_flags`.

End state: `v_rpc_trust_health` = 15 metrics, 0 breaches, 4 Pinnacle sentinels (ask freshness, FMV freshness, render-floor freshness, FMV correctness). `check_public_security_invariants()` + `check_secdef_anon_execute_violations()` both `[]`.

## Optional enhancement — Option A SHIPPED 2026-06-29 (Claude Code, commit `105c9e9`)

**Render-floor intraday freshness — DONE via Option A.** Trevor delegated the call ("do what you think is best for RPC long term"). Shipped Option A (control-flow only, NOT the review-gated source-changing Option B): added `?floors_only=1` to `app/api/admin/backfill-pinnacle-catalog/route.ts` (skips the Phase-1 catalog upsert, runs ONLY the Phase-2 floor sweep — same Studio-GraphQL source + same `pinnacle_catalog_set_floor_asks(p_map)` RPC, so a cadence change, not a pricing-source/logic change). The route now also accepts `INGEST_SECRET_TOKEN` / `CRON_SECRET` (mirrors `drain-topshot-misattribution`) so a Vercel cron can drive it. Wired as a Vercel cron `45 1,7,13,19 * * *` (every 6h) → render-floor lag ~24h → ~6h. Logs a distinct pipeline `pinnacle-catalog-floor-refresh`; the daily full `pinnacle-catalog-backfill` is untouched. `pinnacle_catalog_set_floor_asks` stamps `floor_ask_updated_at` on EVERY row, so each tick also resets `pinnacle_render_floor_stale_hours`. Deploy `dpl_4zeGFGnWcQfaAyNDnfLzvcwTkboY` READY; route 401s unauthed. **Live proof = the 07:45Z tick logging `pinnacle-catalog-floor-refresh` ok + the sentinel dropping to ~0** (couldn't force it in-session — no admin token locally; the daily writer keeps the sentinel < 30h meanwhile). **Revert:** remove the `?floors_only=1` cron object from `vercel.json` + redeploy (the route param is inert without the cron). **Follow-ups (operator/next pass):** after ~2 clean ticks, add `pinnacle-catalog-floor-refresh` to `pipeline_cadence_watchlist` (e.g. 480m/medium) and consider tightening `pinnacle_render_floor_stale_hours` 30h → ~12h.

The original analysis (kept for reference):

## For you — ONE optional enhancement (LOW priority, daily-by-design → review-gated)

**Render-floor intraday freshness.** `pinnacle_catalog.floor_ask` (powers ASK_ONLY FMV + every public render/edition/set page) is full-rewritten ONCE DAILY (~09:37; all rows share one `floor_ask_updated_at`) by the **Phase-2 floor sweep in `app/api/admin/backfill-pinnacle-catalog/route.ts`** (pipeline `pinnacle-catalog-backfill`, lines ~199-235): it pages the Dapper Studio GraphQL `searchPinnacleNft` (live listings, price asc), reduces to a per-render floor, and calls `pinnacle_catalog_set_floor_asks(p_map)`. Meanwhile `pinnacle-listings-reconcile` runs ~every 15 min but only writes the narrow `pinnacle_editions.ask` (~319 editions) — its fresher data never reaches the render-keyed catalog floor. So the public render floor can lag live asks by up to ~24h.

**This is by design, not a bug.** The route comment (lines 124-126) calls the catalog floor "the daily corroboration layer for the intraday listings-indexer" — intraday freshness is *intended* to live in `pinnacle_editions.ask`, daily corroboration in the render floor. Verified healthy + cheap this session: 8 consecutive ok runs, `floor_listed` stable ~2,053-2,128, **full run ~27s** (floor phase alone ~15-20s; `maxDuration` 120). So if you DO want fresher render-page floors:

- **Option A2 (zero code, lowest risk):** add a second daily `pinnacle-catalog-backfill` cron-job.org tick (e.g. ~21:37). Clone the existing daily entry (token is current — it runs ok daily) and change only the time. Route is idempotent (full upsert + full floor rewrite), ~27s, proven. Halves staleness (24h -> 12h). No deploy.
- **Option A (clean code):** add a `?floors_only=1` param that skips Phase 1 (catalog upsert) and runs only the Phase-2 floor sweep (~15-20s), then schedule it intraday (every 3-4h). Same source, same reduction, same RPC — control-flow only, no pricing-logic change. Tighten `pinnacle_render_floor_stale_hours` (now 30h) afterward.
- **Option B (DB, do NOT ship without FMV review):** derive the floor from `pinnacle_listing_events` (live on-chain) instead of the Studio GraphQL — this CHANGES the floor source = a real pricing-source change.

The new `pinnacle_render_floor_stale_hours` sentinel already pages if the daily writer *stalls*; this is purely about cadence. Recommend Option A2 if anything (cheapest, no deploy) — but it's genuinely optional given the by-design separation.

## Verified clean — do NOT redo
- Art 100% (2,272/2,272 `thumbnail_url`).
- FMV reaches wallets: Pinnacle `wmc` 100% `render_id`, 98.6% `fmv_usd`, 100% `image_url` (137 wallets).
- The 2 NO_DATA-with-ask renders are 1-of-1s with lone $30k/$500k moonshot asks — the writer correctly refuses to ASK_ONLY-price them.
- Pinnacle FMV internally consistent: 0/1270 HIGH/MED renders priced >2x max 90d sale; 0 fmv<=0.

## Skill
The `rpc-data` skill's stale Pinnacle FMV line (`pinnacle_fmv_snapshots` "still live") was corrected (dropped table -> 42P01 footgun; the two ask surfaces; dead listings tables). Repo source synced this commit (`docs/cowork-skills/rpc-data/SKILL.md` + `rpc-data.skill`); Trevor installs the rebuilt `.skill` via Save-skill.
