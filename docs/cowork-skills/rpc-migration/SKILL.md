---
name: rpc-migration
description: Use when writing or reviewing a Rip Packs City Supabase database migration — triggers on "write a migration", "apply_migration", "audit_ migration", "schema change", "ALTER TABLE", "CREATE OR REPLACE FUNCTION", "DROP FUNCTION", "new RPC", "new view", or any destructive SQL (DELETE/TRUNCATE/DROP) against project bxcqstmqfzmuolpuynti. Loads the migration pre-flight + post-flight safety checklist distilled from CLAUDE.md and hard-won incidents.
---

# RPC migration safety checklist

Project: `bxcqstmqfzmuolpuynti`. Use `apply_migration` for DDL, `execute_sql` for reads/verification. **One statement per call** — the Supabase MCP returns only the last result of a multi-statement query. Tag migrations `audit_YYYYMMDD_<description>`.

Work through every applicable item before applying, and the verification items after.

## Before writing

1. **Confirm the schema is what you think.** `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='<t>'`. Never trust memory for column names.
2. **Two collection vocabularies (footgun).** Long-form (`nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike`) is used by `sales`, `editions`, `collections.slug`. Short-form (`topshot`, `allday`, `golazos`, `pinnacle`, `ufc`) is used by `flowty_*` tables (CHECK-constrained). They are not interchangeable.
3. **Collection UUIDs:** TopShot `95f28a17-224a-4025-96ad-adf8a4c63bfd`, AllDay `dee28451-5d62-409e-a1ad-a83f763ac070`, Golazos `06248cc4-b85f-47cd-af67-1855d14acd75`, UFC `9b4824a8-736d-4a96-b450-8dcc0c46b023`, Pinnacle `7dd9dd11-e8b6-45c4-ac99-71331f959714`.
4. **Enums are UPPERCASE.** `fmv_confidence` = `HIGH|MEDIUM|LOW|ASK_ONLY|SALES_ONLY|STALE|NO_DATA`. Use `.eq` never `.ilike` on enum columns. `tier_type` = `COMMON|FANDOM|RARE|LEGENDARY|ULTIMATE`; UFC uses `CHALLENGER|CONTENDER|FANDOM`. `nba_player_projections.confidence` uses 3-letter `MED` (different CHECK).

## Functions (the #1 recurring bug)

5. **`CREATE OR REPLACE FUNCTION` with a new/changed signature creates a NEW overload with default `PUBLIC EXECUTE`.** This silently re-grants what a prior `REVOKE` removed. After any signature change: `REVOKE EXECUTE ON FUNCTION <f>(<args>) FROM PUBLIC, anon, authenticated;` then `GRANT EXECUTE ... TO postgres, service_role;` and `DROP FUNCTION` the old overload.
6. **Destructive/maintenance SECDEF functions must NOT have anon/authenticated EXECUTE.** SECDEF bypasses RLS and TRUNCATE isn't governed by RLS at all, so an anon EXECUTE on a DELETE/TRUNCATE/refresh function is an anon-wipe vector. Re-check with `SELECT * FROM check_secdef_anon_execute_violations();` (expect `[]`).
7. **`execute_sql(query text) RETURNS void`** is SECDEF, service_role only — don't widen it.

## Views

8. **Any new PUBLIC view must ship `WITH (security_invoker = on)`** or it lands as a Supabase `security_definer_view` ERROR (a SECDEF view runs with the definer's rights, bypassing the caller's RLS). After creating: `ALTER VIEW public.<v> SET (security_invoker = on);` then confirm anon can still `SELECT` it on its public route (the underlying tables must allow anon SELECT for invoker-mode to keep working). This regressed 14→3 in May 2026.
9. **New public tables: grant anon `SELECT` only and confirm RLS is ON.** Never leave `GRANT ALL ... TO anon`. (Broad write grants on *views* are inert — views aren't RLS-governed and complex views aren't updatable — but base tables with RLS off + anon write are a live hole.)

## fmv_snapshots (partitioned)

10. **Write pattern is delete-then-insert, NEVER upsert.** `collection_id` is `NOT NULL`. Daily duplicate snapshots are intentional history, not a bug.
11. **`CREATE INDEX CONCURRENTLY` must be a standalone `execute_sql`**, NOT inside `apply_migration` (which wraps in a transaction).
12. **Latest-per-edition is `SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC`.** Any `LIMIT 1` over snapshot history without `ORDER BY computed_at DESC` reads an arbitrary partition row. Never filter snapshot history *before* a `DISTINCT ON` re-stamp (the Step-6 self-perpetuating-NO_DATA class of bug).

## Destructive operations

13. **`count(*)` before any TRUNCATE/DROP.** `pg_stat_user_tables.n_live_tup` reads 0 when stats were never collected — never trust it for a destructive decision.
14. **Check dependents before deleting `editions` rows:** `badge_editions` joins via `external_id` (text), `wmc` via `edition_key` (text) — neither has an `edition_id` FK; `user_wishlists`/`watchlist_items` CASCADE-delete. `wmc.edition_key` MUST equal `editions.external_id` (never `editions.id`).
15. **MCP `execute_sql` times out around ~700k-row transactions.** Use `apply_migration` or chunk into sequential migrations.
16. **N-to-1 merges have TWO collision classes** on dependent UNIQUE constraints: dupe-vs-canonical AND intra-dupe. Dry-run both. Active crons write drift rows mid-migration — bundle a drift-repoint-and-delete sweep in the SAME atomic transaction before installing any post-merge invariant trigger.

## After applying

17. **Verify, then write conclusions in a SEPARATE step.** Never fire the migration and the verifying query (or a doc capturing the result) in the same batch — the doc captures the assumed result, not the actual output. Run → read → then record.
18. Re-run the relevant catalog check (RLS on base tables, no anon write on base tables, no anon EXECUTE on destructive fns, `security_invoker` on new views). The `rpc-security-drift` artifact runs all of these.
19. **Log it** in `CLAUDE.md` Recent sessions + `docs/overnight/ledger.md` with the exact revert command.
20. **Cowork deploy-split:** a migration/edge-function ships live from Cowork, but any paired route/.tsx change can't be pushed from here — package it with the `rpc-handoff` skill.
