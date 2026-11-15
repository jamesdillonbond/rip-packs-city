# Claude Code → Cowork: three staged migrations (analytics health · hybrid-custody timeout · R153 player merges) — each needs Trevor's go-ahead

**Filed:** 2026-11-15 ~8:35 AM PT by Claude Code cloud (autonomous session). **Owner:** Trevor (approve) → whoever can answer the destructive-statement dialog (Claude Code live with Trevor present, or Cowork via the Supabase SQL editor in Chrome). **Severity:** LOW–MEDIUM. **Why filed:** `apply_migration` timed out on the connector's confirmation question at ~7:08 AM PT with nobody to answer it; nothing below is applied.

Every file is under `docs/proposals/`. Run each as ONE batch, then insert its `supabase_migrations.schema_migrations` row (SQL-editor path) and commit the file to `supabase/migrations/<version>_<name>.sql` the same session (migration-parity reds otherwise). Ledger entry per apply.

## 1. `analytics-pipeline-health-sales-leg-index-STAGED.sql` — `/api/analytics/health` 500s (deep audit 11-15 D4)

- The `sales_2026` "latest sale in 24 h" leg of `analytics_pipeline_health()` had no plain `sold_at` index and walked every 24 h row via the pkey: 12,591 buffers; the function measured 4.3 s cold against its own 5 s timeout. `AND price_usd > 0` makes it use `idx_sales_2026_fmv_recalc_window` → 5 buffers. Equivalent: 0 non-positive sales in 7 d; same max(sold_at).
- Base verified: live `prosrc` md5 = 20260925060717's body. Not pinned. **Re-read `prosrc` immediately before applying** (CREATE OR REPLACE is a full-body write).
- Read back: `explain (analyze, buffers) select analytics_pipeline_health()` → a few hundred buffers, well under 1 s cold. Name: `audit_20261115_analytics_pipeline_health_sales_leg_uses_index`.

## 2. `hybrid-custody-candidates-timeout-90s-STAGED.sql` — daytime monitor 11-15 16:04Z candidate 2

- `get_hybrid_custody_candidates` (pgss mean 9.1 s, max 24.2 s) is cold-IO bound (first leg 26k disk reads / 8.5 s; same leg warm 0.27 s) and crosses service_role's 30 s under estate IO: 2 of 5 runs failed in 3 days. A function-level `statement_timeout = 90s` (higher per-function timeouts apply via PostgREST; gateway ~120 s).
- Read back: `select proconfig from pg_proc where proname='get_hybrid_custody_candidates'` contains `statement_timeout=90s`. Name: `audit_20261115_hybrid_custody_candidates_timeout_90s`.

## 3. `r153-player-spelling-merges-STAGED.sql` — deep audit R153 (+ 48 Panini country duplicates)

- Part 1 (#139 pattern, by row id): 5 Candy + 2 Panini spelling pairs merged, 4 alias rows for the punctuation variants. ⛔ Luis Garcia (Astros) / Luis García (Nationals) are TWO players and are excluded — they share the slug `luis-garcia`, so one of them has no reachable page; fixing that needs a rename (e.g. MLB.com's "Luis García Jr.") = Trevor's call (the 09-25 decision is "alias, never rename").
- Part 2: 48 Panini national-team names exist as two rows (`panini_blockchain-<slug>` from the 09-26 name writer, `panini-<slug>` from the bridge on 10-03); 107 Team Badges editions move to the bridge's row. Guarded (40–60 pairs, no refs outside editions), post-condition 0 duplicate Panini slugs.
- Backups `audit_20261115_r153_players_backup` / `_editions_backup` (RLS on). Contains DELETE ⇒ the connector prompts.
- Read back: `/candy-mlb/player/yordan-alvarez` lists 60 editions (58 + 2), `/candy-mlb/player/cal-ripken-jr` 308s to the kept row's slug, `/panini-blockchain/player/argentina` lists 24. Name: `audit_20261115_r153_player_spelling_merges`.

## Resolution

(append here when applied)
