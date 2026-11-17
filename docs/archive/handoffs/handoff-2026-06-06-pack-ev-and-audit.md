# Handoff 2026-06-06 — Pack EV accuracy + full-platform audit code items

Claude Code: direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Context

Full-platform audit + pack-EV accuracy pass ran in Cowork today (interactive, Trevor-approved each ship). Already LIVE via Supabase connector (no git involved): migration audit_20260606_pinnacle_fmv_recalc_all_null_guard (PIN-FMV2 crash fix — pinnacle_fmv_recalc_all crashed 23502 on a null-FMV edition since ~06-04, table was frozen at 06-04 05:40Z; fixed + manually re-run: 427 editions fresh, 1 skipped), audit_20260606_revoke_anon_nonsecinvoker_views_and_recalc_fn (11 anon-readable owner-privilege views closed: support_weekly_summary, beta_feedback_inbox, fmv_current, pipeline_health, data_coverage_dashboard, bc_continuity_status, v_collection_marketplace_status, 4 flowty_* — all production readers are supabaseAdmin server-side, verified by grep; posture back to 0), audit_20260606_pack_pool_canonical_remap_and_rpcs (one-time re-map of 15,288 pack_drop_pool rows from inert UUID-dupe editions to canonical int-keyed editions via a strict unique 5-field match, backup table audit_packpool_uuid_remap_20260606; buyable-pack pool FMV coverage measured 40 percent -> 80.7 percent; also created SECDEF service-role-only RPCs merge_pack_dist_meta + remap_pack_pool_uuid_key for v20), audit_20260606_drain_cold_tail_skip_inert_uuid_editions (DUPE1-MIT, ledger-queued, Trevor-approved: drain_fmv_cold_tail now skips inert UUID editions — stops ~5.3k junk NO_DATA stamps/48h; grants verified postgres+service_role only). Edge function compute-topshot-pack-ev v20 DEPLOYED live via MCP (platform version 35): pool keys now prefer set.flowId:play.flowID with auto-fallback to the legacy UUID query, hydration re-keys pool rows via remap_pack_pool_uuid_key, per-pack remainingByTier/originalCountsByTier persist into pack_distributions.metadata via merge_pack_dist_meta. HEAD at write time: b293ba1 (verify with git log).

The working tree ALREADY CONTAINS uncommitted changes this handoff commits (do not re-type them — they are on disk): the P1-CAD route fix, the v20 edge-function repo sync, and the overnight passes' NO-PUSH doc outputs (handoff docs, ledger.md + CLAUDE.md edits, metrics-latest.json, deleted drained inbox files). Run scripts/check-tree-corruption.mjs before committing.

## Item 1 (P0, mostly done — commit the tree)

Files already patched on disk by Cowork, verified surgical via git diff --numstat:
- app/api/cron/pinnacle-metadata-backfill/route.ts (2 insertions, 2 deletions): the em-dash inside PINNACLE_METADATA_SCRIPT (serial comment, ~L104) is now an ASCII hyphen, and script encoding at ~L243 switched from btoa(PINNACLE_METADATA_SCRIPT) to Buffer.from(PINNACLE_METADATA_SCRIPT, utf8).toString(base64) per the CLAUDE.md API-contracts rule. Root cause of P1-CAD: b6005cb added the script's only non-ASCII char; Node btoa() throws InvalidCharacterError on non-Latin1, so every tick since 06-06 02:22Z failed at encode time (11/22 fails in the last 24h, error cadence: Invalid character). The Buffer.from switch makes the whole class impossible.
- supabase/functions/compute-topshot-pack-ev/index.ts: full v20 file, byte-identical to what is deployed (deployed v34 source was verified byte-identical to repo v19 before patching, so repo/live stay in sync after commit).

Suggested commits (PowerShell git, direct to main, no branch, no PR):
1. fix(pinnacle): P1-CAD em-dash x btoa crash in metadata-backfill Cadence encode + feat(pack-ev): v20 canonical int-pair pool keys, tier-count persistence, pool re-key (repo sync; deployed live via MCP as platform v35)
2. docs: land 2026-06-05/06 overnight-pass NO-PUSH outputs (ledger, handoffs, metrics, drained inboxes)

Verify: npx tsc --noEmit clean; deploy READY; next pinnacle-metadata-backfill :22 tick logs ok=true with extra.serials_filled present and no cadence error; pipeline_runs for compute-topshot-pack-ev shows extra.function_version=20 with int_pair_keys greater than 0 and uuid_fallback_keys ~0.
Revert: git revert the fix commit; edge function rollback = git show HEAD~1:supabase/functions/compute-topshot-pack-ev/index.ts then redeploy (or Supabase dashboard rollback to version 34). P1-CAD alternative was git revert b6005cb — NOT needed now.

## Item 2 (P1 — pack dist page: contents visualization + dead-stat cleanup)

File: app/(collections)/[collection]/pack/dist/[distId]/page.tsx (1,091 lines, verified exists; fields total_sealed/depletion_pct at ~L52/425). Motivation: live-page audit of /nba-top-shot/pack/dist/1726 and /3097 — every What's Inside tile rendered No image / NO DATA noise pre-remap; KPI row shows a dead 0/0 sealed subline and a hardcoded-looking DEPLETION 0 percent for every pack; EV verdict renders authoritative red/green margins even at 23-26 percent FMV coverage. Top Shot's own pack pages lead with slots + per-tier hit chances, which RPC data now supports.

2a. KPI row honesty:
- PACKS REMAINING tile: drop the sealed subline whenever total_sealed and total_minted are 0 or null — verified ALL 1,959 TS pack_distributions rows have total_sealed=0 and total_minted<=total_opened, the columns are dead. Keep the remaining count itself.
- DEPLETION tile: compute from pack_distributions.metadata total_pack_count / total_unopened when tier_counts_updated_at exists (v20 maintains these per sweep): depletion = (total_pack_count - total_unopened) / total_pack_count. Fall back to pack_ev_latest depletion_pct. If neither source, hide the tile entirely — never render a default 0 percent.

2b. NEW Pull odds by tier panel (the Top Shot parity piece): read metadata.remaining_by_tier, metadata.original_counts_by_tier, metadata.total_unopened, metadata.tier_counts_updated_at from pack_distributions. For each tier with original count greater than 0 render: tier chip (existing tierColorVar / TIER_STRIPE vocab incl. UFC tiers), remaining vs original, percent of remaining pool, and approximate per-pack hit odds = 1 - (1 - tierRemaining/totalUnopened)^slots displayed as about 1 in N packs (slots from metadata.number_of_pack_slots, fall back 3/5 as the page already does). Show as-of relative time from tier_counts_updated_at. Render the panel only when remaining_by_tier exists — v20 populates it as the EV sweep touches each pack, so buyable packs fill within ~a day; historical untouched packs simply do not show the panel.

2c. What's Inside restructure:
- TOP PULLS hero strip: top 5 pool editions by FMV as larger tiles above the grid.
- Split grid: Pullable (drop_weight greater than 0, default visible, FMV desc default sort kept) and a collapsed Exhausted (N) section for drop_weight=0 rows (currently they render as dead dash/NO DATA/Wt 0 tiles at the bottom — pure noise).
- Honesty chip next to the heading: FMV priced X of Y pullable editions (Z percent) computed from the same rows the grid already has.
- Tile image: onError fallback to the existing No image treatment; post-remap most tiles have art but ~46 percent of TS canonical editions still lack thumbnail_url (separate catalog backfill keeps draining).
- Pack hero image: add onError hide/fallback — dist 1726's image_url is a dead asset and renders a blank box today.

2d. EV verdict coverage gating: when fmv_coverage_pct is below 80, render value-ratio / net-margin in neutral (no red/green) with suffix: based on N percent FMV coverage — treat EV as a floor. Keep the existing colored verdict at 80 plus. Note: coverage on buyable packs is already 80.7 percent at the pool layer after today's re-map and rises as v20 re-sweeps; pack_ev_latest.fmv_coverage_pct refreshes per pack as the cron rotates (forced by nothing — give it a day).

No RPC/DB changes needed for any of 2a-2d — all inputs exist now. Page-layer only. Revert: git revert the commit.

## Item 3 (P2 — pinnacle-sync observability, closes the PIN-FMV blind spot)

File: app/api/cron/pinnacle-sync/route.ts (verified exists; calls pinnacle_fmv_recalc_all at ~L33 and logs nothing). This route's external cron silently died AND the underlying fn crashed for 2.4 days with zero monitoring signal — pinnacle_fmv_snapshots is replace-in-place and the route never writes pipeline_runs, so detect_stalled_pipelines was blind (documented blind spot, now actually bitten).
- Wrap the handler with log_pipeline_run (p_pipeline pinnacle-sync) on success AND failure, carrying the pinnacle_fmv_recalc_all jsonb result (editions_processed / editions_skipped_no_data) or error in p_extra, mirroring any sibling cron route's logging shape (e.g. app/api/cron/refresh-cross-collection).
- AFTER the route logs in production, apply this follow-up migration (Cowork or CC via connector) so a future stall pages:
  INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, is_active, notes) VALUES (pinnacle-sync, 1560, medium, true, Daily Pinnacle FMV rebuild (pinnacle_fmv_recalc_all) + listings sync. 26h threshold = daily + 2h grace. Added after the 2026-06-04..06 silent freeze (PIN-FMV2).) ON CONFLICT (pipeline) DO NOTHING;
  (Adapt to the actual watchlist column shape before running; do NOT apply before the route logs at least one run or it false-positives immediately.)
- Operator half (Trevor, cron-job.org): re-create/verify a daily entry hitting https://www.rippackscity.com/api/cron/pinnacle-sync with the bearer token. Until then, Pinnacle FMV refresh is manual (Cowork ran it today 15:40Z).

## Item 4 (P3, optional — SMOKE-RETRY, ledger-queued)

app/api/smoke-test/route.ts: add a single retry with short backoff for checks that fail on the infra-timeout class (connection pool / statement timeout / fetch timeout) so the 00:17Z-style cron-rush mass-fail (7 Sentry issues, all 1-event) stops firing. Keep genuine assertion failures un-retried. Leave queued if you want the suite maximally paranoid.

## Operator items (Trevor, not Claude Code)

- N1: snapshot-institutional-wallets stalled 38h+ (3rd time) — re-fire the cron-job.org entry and move its 06:00Z slot off the cron rush.
- CROSS1: add the daily cron-job.org entry for /api/cron/refresh-cross-collection (route deployed 06-05, still 0 runs), then retire the interim Cowork scheduled task rpc-cross-collection-refresh.
- pinnacle-sync cron entry (see Item 3).
- Sentry: the 7 smoke-test issues from 06-06 00:17Z + listing_resolution_failures_inserted are transient — mark resolved after 24h quiet.
- next 16.1.6 -> 16.2.7 bump (3 HIGH advisories incl. middleware/proxy-bypass CVEs that bear on proxy.ts auth) — flagged by the 06-05 dependency digest, needs package.json+lockfile so it is a CC/Trevor task; fine to fold into a daytime session.
- pack_listings_cache is a zombie: 281 NFL All Day rows sourced from dead Flowty, still being refreshed (latest cache today), zero TS rows, no product reader found. Decide teardown (stop the refresher leg + optionally drop) — queued, not auto-shipped.

## Ledger + CLAUDE.md updates (append via this commit, do not edit from Cowork)

docs/overnight/ledger.md — move DUPE1-MIT from Queued to Shipped (migration audit_20260606_drain_cold_tail_skip_inert_uuid_editions, revert = re-CREATE prior body, target metric: cold-tail-1.0 stamps on inert UUID editions/24h -> 0); mark P1-CAD fix as in-tree/committed by this handoff; add Shipped entries for the 4 Cowork migrations + edge fn v20 above (revert paths: views = re-GRANT SELECT to anon; recalc fn = re-CREATE prior body; re-map = restore from audit_packpool_uuid_remap_20260606 (UPDATE pack_drop_pool pp SET edition_id=b.old_edition_id, edition_flow_id=b.old_edition_flow_id FROM audit_packpool_uuid_remap_20260606 b WHERE pp.collection_id=b.collection_id AND pp.dist_id=b.dist_id AND pp.slot_name=b.slot_name AND pp.edition_id=b.new_edition_id); v20 = redeploy v34 source). New queued item: PIN-SYNC-OBS (Item 3) and PACKVIZ (Item 2) if not shipped same-day.

## Guardrails (repeat every handoff)

- Direct to main. No branches. No PRs. If a claude/* branch is pre-checked out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push: git rev-list --count origin/main..HEAD expects 0.
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s; higher silently ERRORs the deploy.
- CRLF: no string-replace patching; full-file writes or line-index edits.
- Run node scripts/check-tree-corruption.mjs before committing (the tree carries multi-session work).

## Expected end state

Two commits on main, deploy READY: pinnacle-metadata-backfill ticks green again (P1-CAD closed), repo matches the live v20 edge function, overnight docs landed; then (same or next session) the pack dist page ships tier odds + clean KPIs + restructured What's Inside, and pinnacle-sync becomes observable. Metrics to watch: pack_ev_latest avg fmv_coverage_pct on price_source=secondary rising from 36 toward 85+, sentinel TS-UUID-48h decelerating from ~52/hr toward ~0 new/day, pinnacle_fmv_snapshots max(computed_at) under 26h from tomorrow.
