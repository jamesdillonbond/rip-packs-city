# Handoff 2026-06-07 — PIN-FMV-REKEY Waves 2 + 3: finish the per-render FMV reader cutover

CONTEXT

Phase A (additive render-keyed engine on pinnacle_catalog.fmv_*) + Wave 1a (populate_pinnacle_wmc_fmv) + Wave 1b (scarcity board, pin page /pinnacle/moment/[id], get_pinnacle_render_fmv) are LIVE. Legacy pinnacle_fmv_snapshots (edition_id-keyed, pinnacle-1.0.0) is UNTOUCHED and still refreshed by pinnacle-sync alongside the render engine, so nothing is broken today — this handoff retires the remaining legacy readers in two sequenced waves, then the legacy table itself. Master inventory + formula evidence: docs/handoff-2026-06-06-pinnacle-per-render-fmv-recompute-review.md (top section). 1,789 of 2,079 renders priced; the proof case is Kylo Ren Helmet $277.67 vs $23-33 set-mates (a 16x spread the legacy blend collapsed).

EXECUTION RULES (why this is waved)

- One wave per session. After each wave Trevor eyeballs 3-5 live surfaces BEFORE the next wave starts — every swap changes displayed prices, that's the point, but it must be verified against pinnacle_catalog.fmv_usd for known render_ids, not assumed.
- The 1:many caveat drives every product call: one legacy edition_id fans out to many render_ids. Surfaces keyed by edition_id can't 1:1 swap — each needs a decision: (a) per-render rows (preferred where layout allows), (b) min-max range display, or (c) representative render (highest sales_count_30d). Flag the choice per surface in the commit message.
- DB function swaps can be shipped live by Cowork on request (say which fn and the decided keying) — route/.tsx swaps are yours.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file/function shape. Several Wave 2 fns may already be partially render-aware from the Wave 1b ship; grep before editing.

WAVE 2 — entity/team/cross-collection readers (the user-visible price surfaces)

Functions (grep each in supabase migrations or pg_get_functiondef; swap reads of pinnacle_fmv_snapshots → pinnacle_catalog.fmv_usd/fmv_confidence/fmv_computed_at, keyed per the product call above):
get_pinnacle_moment_detail, get_edition_detail, get_moment_detail, moment_detail, get_team_detail, get_team_checklist, get_team_checklist_progress, get_team_players, get_team_top_editions, get_set_detail, get_player_detail, get_series_detail, get_set_editions, get_player_editions, get_series_editions, get_cross_collection_deals (NOTE: cross_collection_deals_board view already reads per-render FMV for Pinnacle after the 06-07 deals ship — verify before touching), get_cross_collection_portfolio, get_pinnacle_overview, get_pinnacle_top_movers, get_wallet_moments_with_fmv, holdings_summary, get_edition_fmv_history (product call: per-render history comes from pinnacle_catalog.fmv_computed_at single-point — the legacy table holds the only true history; consider leaving this one on legacy until retirement and accepting the gap, or snapshotting render FMVs to a small history table first), pinnacle_fmv_from_listings, pinnacle_fmv_from_sales, bridge_pinnacle_fmv_to_main (follow where it bridges TO before swapping).

Wave 2 verification: /disney-pinnacle entity pages + team hub + /insights/deals Pinnacle rows + dashboard portfolio totals all show per-render prices; for the SWHM test key, Kylo-related surfaces read ~$277 not ~$30; npx tsc --noEmit clean; deploy READY; smoke green.
Wave 2 revert: point the swapped fns back to pinnacle_fmv_snapshots (bodies unchanged otherwise); git revert the route commit.

WAVE 3 — stats/health/analytics + routes (low user visibility, do last)

health_check, pinnacle_health_check, the 3 analytics_* fns from the inventory, views data_coverage_dashboard / data_quality / pipeline_health; routes app/api/collection-stats (it does the exact DISTINCT ON (edition_id) FROM pinnacle_fmv_snapshots pattern — swap to a straight read of pinnacle_catalog fmv columns), app/api/overview-stats, app/api/sniper-feed (Pinnacle leg), app/api/pinnacle-listings-indexer.

Wave 3 verification: /analytics + overview pages render; health_check returns sane Pinnacle numbers; no Sentry novelty in 24h.

RETIREMENT (only after a repo-wide + pg_proc grep for pinnacle_fmv_snapshots hits ZERO readers)

1. Stop the legacy writer: remove the pinnacle_fmv_recalc_all (legacy) call from app/api/cron/pinnacle-sync/route.ts, keep the render recompute.
2. Cowork ships the drop migration on request: drop legacy fns + table (exact bodies are captured in the review doc for revert).
3. Watchlist note: do NOT add pinnacle watchlist rows by hand — the scheduled task rpc-watchlist-pinnacle-crons (fires 2026-06-08 09:30) handles pinnacle-sync/pinnacle-fmv-recalc watchlisting idempotently.

GUARDRAILS (standard)
- Direct-to-main, no branches, no PRs. PowerShell git for commits; verify push with git rev-list --count origin/main..HEAD (expect 0). curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest. maxDuration cap 800s. Full-file replacements; no CRLF string-patching. tsc + smoke after every wave.

END STATE: every Pinnacle price on the site is per-render (no blended set-level numbers anywhere), legacy pinnacle_fmv_snapshots + pinnacle-1.0.0 writer retired, pinnacle-sync runs the render engine only, watchlists in place via the scheduled task.
