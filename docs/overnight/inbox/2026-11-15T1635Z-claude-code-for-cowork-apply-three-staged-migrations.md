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

## Note on §2 — Claude Code cloud (live session), 2026-11-15 ~8:40 AM PT

Measured independently before seeing this filing: the 11-15 failures are the Sunday **"all" pages 1 and 2** (2:23 / 2:33 AM PT, jobs 646/647), so offsets 0..5,899 of 6,579 candidates were not probed this week; page 3 ran. A one-pass body (`CROSS JOIN LATERAL (VALUES (buyer),(seller))`) returns the identical array (7,061 = 7,061) at 69,796 vs 142,669 buffers — but this filing's point stands that the second leg is warm, so it saves buffers, not disk reads. The 90 s timeout is the fix; the one-pass rewrite is optional and was not staged. This session's own `apply_migration` was refused by its permission classifier, so it could not apply §2 either. Watch after the apply: Sun 11-22 ~2:45 AM PT, three `hybrid_custody_backfill` `scope: all` rows all ok.
- **2026-11-15 ~9:30 AM PT (Claude Code cloud, Trevor: "apply all three"):** ✅ **#1 APPLIED** `20261115172732` (read back: 20 ms / 2.4k blocks, was 4.3 s; output unchanged). ✅ **#2 APPLIED** `20261115172736` (`statement_timeout=90s` in proconfig). Both migration files committed from prod's stored statements (md5-verified); their STAGED copies removed. ⏳ **#3 (R153) NOT applied** — the destructive-statement confirmation went unanswered again; verified nothing landed. Still staged at `docs/proposals/r153-player-spelling-merges-STAGED.sql`; Trevor approved it, so it only needs someone to answer the dialog (or the SQL-editor path).
- **2026-11-15 ~9:34 AM PT — HANDED TO COWORK (Trevor: "Hand that off to cowork"). #3 is APPROVED by Trevor ("apply all three") — run it in the Supabase SQL editor in Chrome.** The connector's destructive-statement confirmation timed out twice more (9:28, 9:32 AM PT) with Trevor present, so the dialog does not reach him from the Claude Code client. Verified after each: nothing landed.
  1. **Pre-check (stop if different):** `select to_regclass('public.audit_20261115_r153_players_backup')` → NULL; the 7 drop ids in the file's VALUES list all exist (`count(*) = 7`); the part-2 pair count (the CTE in the file's Part 2, as a `count(*)`) = 48.
  2. **Run** `docs/proposals/r153-player-spelling-merges-STAGED.sql` as ONE batch. It aborts itself on any surprise (a keep row missing, a drop row referenced outside `editions`, part 2 outside 40–60 pairs, any post-condition).
  3. **History row:** `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261115_r153_player_spelling_merges');`
  4. **Read back:** `select count(*) from player_name_aliases where note like 'R153%'` → 4; `select count(*) from audit_20261115_r153_players_backup` → 55 (7 + 48); live pages: `/candy-mlb/player/yordan-alvarez` lists the merged editions, `/candy-mlb/player/cal-ripken-jr` redirects to the kept row's page, `/panini-blockchain/player/argentina` lists 24 editions.
  5. **Repo, same session:** `git mv docs/proposals/r153-player-spelling-merges-STAGED.sql supabase/migrations/<version>_audit_20261115_r153_player_spelling_merges.sql`; ledger entry FIRST (revert path is in the file header); mark this filing ✅ here and on its INDEX.md line; deep-audit register R153 → resolved (Luis Garcia/García stays open — two players, one slug — Trevor's rename call).
