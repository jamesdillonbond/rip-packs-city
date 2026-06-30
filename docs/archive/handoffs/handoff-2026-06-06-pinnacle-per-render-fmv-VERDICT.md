# REVIEW VERDICT — Pinnacle per-render FMV recompute (PIN-FMV-REKEY)

Reviewing docs/handoff-2026-06-06-pinnacle-per-render-fmv-recompute-review.md. Cowork review performed 2026-06-06 against the live DB. Net: **the pricing logic is APPROVED as drafted; the ship plan is AMENDED — the atomic reader-cutover premise fails on the real reader inventory. Restructure as additive (new render-keyed home), migrate readers in waves, retire legacy at zero readers.** Trevor: if you agree, hand CC this verdict + the original doc together.

## What I verified (live)

1. **Evidence is real.** `STAR-OEV1-SWHM:Digital Display:1` per-render (90d): Kylo Ren $278.30 avg / 23 sales vs set-mates $25–32 — the ~16x spread reproduces exactly. Prereqs confirmed: sales render_id 13,152/13,154 (2 brand-new sales pending the ongoing stamp), 0 wmc disagreements, 1,946 floors fresh, inert `pinnacle_fmv_snapshots.render_id` column in place.
2. **`log_pipeline_run` signature matches** the draft's positional PERFORM: (p_pipeline, p_started_at, p_rows_found, p_rows_written, p_rows_skipped, p_ok, p_error, p_collection_slug, p_cursor_before, p_cursor_after, p_extra jsonb). Checklist item closed.
3. **The recompute formula is unchanged** from pinnacle-1.0.0 (exp-decay WAP, 0.33x–3x outlier trim, same confidence/liquidity gates) — only the grouping key changes. Correct minimal change.

## Amendment 1 (the big one) — the reader inventory is ~40+, not 4

The review doc lists 4 readers to cut over atomically. The actual count against the live catalog + repo:

- **33 DB functions** read `pinnacle_fmv_snapshots`: the 2 listed (populate_pinnacle_wmc_fmv, get_pinnacle_edition_fmv) PLUS get_pinnacle_moment_detail, get_edition_detail, get_moment_detail, moment_detail, the ENTIRE team hub (get_team_detail / get_team_checklist / get_team_checklist_progress / get_team_players / get_team_top_editions), get_set/player/series_detail + _editions, get_cross_collection_deals / _portfolio, get_pinnacle_overview, get_pinnacle_top_movers, get_wallet_moments_with_fmv, holdings_summary, get_edition_fmv_history, pinnacle_fmv_from_listings / _from_sales, bridge_pinnacle_fmv_to_main, health_check / pinnacle_health_check / analytics_* (3).
- **4 views**: pinnacle_scarcity_board, data_coverage_dashboard, data_quality, pipeline_health.
- **~5 routes/pages** query it directly: app/api/collection-stats (does literally `DISTINCT ON (edition_id) ... FROM pinnacle_fmv_snapshots` — the exact pattern the doc's own risk section flags), app/api/overview-stats, app/api/sniper-feed, app/api/pinnacle-listings-indexer, app/pinnacle/moment/[id]/page.tsx.

A one-deploy atomic cutover of ~40 readers is not realistic, and any miss silently serves an arbitrary render's price for a whole set. **Restructure instead — the same playbook that made the catalog re-key safe (pinnacle_catalog landed BESIDE pinnacle_editions):**

- Write per-render FMV to a render-keyed home: either a new `pinnacle_fmv_render_snapshots` table, or (cleaner) FMV columns / a sibling keyed on `pinnacle_catalog.render_id`, next to the floor_ask that already lives there.
- Leave the legacy `pinnacle_fmv_snapshots` writer (pinnacle-1.0.0) RUNNING UNCHANGED — zero readers break on day one. Do NOT delete-rebuild the legacy table with per-render rows.
- Migrate readers in waves: Wave 1 (user-facing value): populate_pinnacle_wmc_fmv (wmc.render_id join — cleanest), app/pinnacle/moment page, pinnacle_scarcity_board, get_pinnacle_edition_fmv. Wave 2: entity/team/cross-collection fns. Wave 3: stats/health/analytics + routes. Each wave independently verifiable.
- Retire the legacy writer + table only when the reader grep hits zero. Keep `bridge_pinnacle_fmv_to_main` in mind — whatever it bridges follows the same wave.

## Amendment 2 — grants (secdef-regression class)

The draft's CREATE FUNCTIONs carry no grants: new functions default to PUBLIC EXECUTE. Add explicit `REVOKE ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;` for both new fns. Free adjacent cleanup while in there: the EXISTING `pinnacle_fmv_recalc` currently has stray anon+authenticated EXECUTE (verified in proacl) — revoke it (its sibling `pinnacle_fmv_recalc_all` is already correctly postgres+service_role only).

## Amendment 3 — the in-function failure log is decorative

The EXCEPTION block PERFORMs log_pipeline_run then RAISEs — the re-raise rolls back the transaction INCLUDING that log row, so failure-path logging never persists. Fine to keep or drop, but rely on the route-level ok=false logging (shipped this session in pinnacle-sync observability) as the real failure signal. Success-path logging inside the fn persists and is good.

## Unchanged from the draft (still right)

Per-render confidence will drop on thin renders — correct, don't loosen gates. floor_usd from pinnacle_catalog.floor_ask. algo 'pinnacle-2.0.0-render'. Watchlist `pinnacle-fmv-recalc` after 48h cadence. Spot-checks: Kylo DD ~$278 separates from $17–32 set-mates; a held wmc pin re-populates per pin.

## Revert (amended structure makes it trivial)

Additive table/columns + untouched legacy writer = revert is just pointing migrated readers back; no function-body restore needed until the final retirement step.
