---
name: rpc-migration
description: Use when writing or reviewing a Rip Packs City Supabase database migration — triggers on "write a migration", "apply_migration", "audit_ migration", "schema change", "ALTER TABLE", "CREATE OR REPLACE FUNCTION", "DROP FUNCTION", "new RPC", "new view", or any destructive SQL (DELETE/TRUNCATE/DROP) against project bxcqstmqfzmuolpuynti. Loads the migration pre-flight + post-flight safety checklist distilled from CLAUDE.md and hard-won incidents.
---

# RPC migration safety checklist

Project: `bxcqstmqfzmuolpuynti`. Use `apply_migration` for DDL, `execute_sql` for reads/verification. **One statement per call** — the Supabase MCP returns only the last result of a multi-statement query. Tag migrations `audit_YYYYMMDD_<description>`.

Work through every applicable item before applying, and the verification items after.

## Before writing

1. **Confirm the schema is what you think.** `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='<t>'`. Never trust memory for column names.
2. **Two collection vocabularies (footgun).** Long-form (`nba_top_shot`, `nfl_all_day`, `laliga_golazos`, `disney_pinnacle`, `ufc_strike`) is used by `sales`, `editions`, `collections.slug`. Short-form (`topshot`, `allday`, `golazos`, `pinnacle`, `ufc`, **`unknown`** — six values) is used by the `flowty_*` tables. ⚠ **The CHECK exists on `flowty_transactions` ONLY** (verified against `pg_constraint` 2026-08-24); `flowty_loans` and `flowty_loan_events` carry no `collection` CHECK. So a wrong value (a long-form `'ufc_strike'`, or `'other'` — **`other` is NOT valid**) fails LOUDLY on the first table and persists SILENTLY on the other two, where it simply never matches. They are not interchangeable; bridge long→short with the `analytics_sales` view's CASE.
3. **Collection UUIDs — there are SEVEN, not five.** Read them from the live-derived table in `docs/reference/schema-truth.md` rather than a hardcoded list here (re-verified against `public.collections` 2026-08-24, zero drift). The five published Flow collections are joined by **`candy_mlb` (`solana`)** and **`panini_blockchain` (`ethereum`)**, both `is_active=false` — ⚠ **but `is_active` is NOT the public-visibility switch**: both have public insights boards, so a "how many" query that stops at the five silently undercounts.
4. **Enums are UPPERCASE.** `fmv_confidence` = `HIGH|MEDIUM|LOW|ASK_ONLY|SALES_ONLY|STALE|NO_DATA`. Use `.eq` never `.ilike` on enum columns. `tier_type` = `COMMON|FANDOM|RARE|LEGENDARY|ULTIMATE`; UFC uses `CHALLENGER|CONTENDER|FANDOM`. `nba_player_projections.confidence` uses 3-letter `MED` (different CHECK).

## Functions (the #1 recurring bug)

5. **`CREATE OR REPLACE FUNCTION` with a new/changed signature creates a NEW overload with default `PUBLIC EXECUTE`.** This silently re-grants what a prior `REVOKE` removed. After any signature change: `REVOKE EXECUTE ON FUNCTION <f>(<args>) FROM PUBLIC, anon, authenticated;` then `GRANT EXECUTE ... TO postgres, service_role;` and `DROP FUNCTION` the old overload.
6. **Destructive/maintenance SECDEF functions must NOT have anon/authenticated EXECUTE.** SECDEF bypasses RLS and TRUNCATE isn't governed by RLS at all, so an anon EXECUTE on a DELETE/TRUNCATE/refresh function is an anon-wipe vector. Re-check with `SELECT * FROM check_secdef_anon_execute_violations();` (expect `[]`).
7. **`execute_sql(query text) RETURNS void`** is SECDEF, service_role only — don't widen it.
8. 🚨 **THE MIGRATION FILE ITSELF MUST STATE THE anon-EXECUTE DECISION, OR CI REDS `main`.** `__tests__/migration-new-function-states-its-anon-exec-decision.test.ts` walks every migration from version `20260817000000` forward and fails on any file containing `CREATE [OR REPLACE] FUNCTION public.X(` that neither revokes nor states why not. **This reddened `main` FIVE TIMES on 2026-08-28 alone, across two concurrent sessions** — it is currently the most common way a correct migration fails CI.
   - **For a `CREATE OR REPLACE` of an EXISTING function the answer is the MARKER, never a REVOKE** — `CREATE OR REPLACE FUNCTION` does *not* reset a function ACL, so adding a revoke would silently CHANGE production while the file reads as a body-only edit.
   - ⚠ **The marker must put `anon-exec:` AND the function name on the SAME LINE** — the detector is `/anon-exec:\s*\S+/i` tested per line, then the function name matched on that same line. Splitting them across a wrapped comment fails, and the error message does not say so. One line per function:
     `-- anon-exec: unchanged (my_fn) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.`
   - ⚠ **It is keyed PER FUNCTION NAME, not per file** — a file touching three functions needs three markers.
   - ⚠ **A `REVOKE ... FROM PUBLIC` alone does NOT satisfy it** (nor production): this DB carries `ALTER DEFAULT PRIVILEGES` rows for anon + authenticated that survive a PUBLIC-only revoke. Name all three.
   - ⛔ **Never state a decision you have not READ.** Verify with `has_function_privilege('anon', oid, 'EXECUTE')` — never the `proacl` text — and quote that in the marker.

## Views

8. **Any new PUBLIC view must ship `WITH (security_invoker = on)`** or it lands as a Supabase `security_definer_view` ERROR (a SECDEF view runs with the definer's rights, bypassing the caller's RLS). After creating: `ALTER VIEW public.<v> SET (security_invoker = on);` then confirm anon can still `SELECT` it on its public route (the underlying tables must allow anon SELECT for invoker-mode to keep working). This regressed 14→3 in May 2026.
9. **New public tables: grant anon `SELECT` only and confirm RLS is ON.** Never leave `GRANT ALL ... TO anon`. (Broad write grants on *views* are inert — views aren't RLS-governed and complex views aren't updatable — but base tables with RLS off + anon write are a live hole.)

## fmv_snapshots (partitioned)

10. **Write pattern is delete-then-insert, NEVER upsert.** `collection_id` is `NOT NULL`. Daily duplicate snapshots are intentional history, not a bug.
11. **`CREATE INDEX CONCURRENTLY` must be a standalone `execute_sql`**, NOT inside `apply_migration` (which wraps in a transaction). ⚠ **In practice `CONCURRENTLY` is reachable ONLY via a one-statement pg_cron job (libpq), never `execute_sql`.**
12. **Latest-per-edition is `SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC`.** Any `LIMIT 1` over snapshot history without `ORDER BY computed_at DESC` reads an arbitrary partition row. Never filter snapshot history *before* a `DISTINCT ON` re-stamp (the Step-6 self-perpetuating-NO_DATA class of bug).

## Destructive operations

13. **`count(*)` before any TRUNCATE/DROP.** `pg_stat_user_tables.n_live_tup` reads 0 when stats were never collected — never trust it for a destructive decision.
14. **Check dependents before deleting `editions` rows:** `badge_editions` joins via `external_id` (text), `wmc` via `edition_key` (text) — neither has an `edition_id` FK; `user_wishlists`/`watchlist_items` CASCADE-delete. `wmc.edition_key` MUST equal `editions.external_id` (never `editions.id`).
15. **MCP `execute_sql` times out around ~700k-row transactions.** Use `apply_migration` or chunk into sequential migrations.
16. **N-to-1 merges have TWO collision classes** on dependent UNIQUE constraints: dupe-vs-canonical AND intra-dupe. Dry-run both. Active crons write drift rows mid-migration — bundle a drift-repoint-and-delete sweep in the SAME atomic transaction before installing any post-merge invariant trigger.

## Traps this checklist was missing (added 2026-08-24)

- 🚨 **Every `apply_migration` causes a ~10–20 s burst of user-facing `PGRST002` 500s** while PostgREST re-introspects the schema cache. **Prefer a low-traffic window and BATCH migrations.** `rpcWithRetry` does not save you — it retries for ~250 ms of a twenty-second outage.
- ⚠ **`CREATE OR REPLACE VIEW` with no `WITH` clause RESETS reloptions and silently strips `security_invoker=on`** (four occurrences). This is distinct from item 8, which is about NEW views — the replace path un-does a fix that is already in place. Repair with `ALTER VIEW … SET (security_invoker = on)`. It also **cannot rename or reorder columns** (`42P16`), and a rolled-back SQL test cannot catch that, because it builds the object where no prior definition exists.
- ⚠ **Verify a REVOKE with `has_function_privilege`, never the ACL text**, and revoke **`FROM PUBLIC, anon, authenticated` in ONE statement** — this DB carries both a PUBLIC default and `ALTER DEFAULT PRIVILEGES` grants, so either half alone leaves the hole open. Re-run `check_secdef_anon_exec_drift()` after creating ANY function.

## Traps added 2026-09-20 (R118 and the leg-324 pass)

- 🚨 **`EXCEPTION WHEN OTHERS` DOES NOT CATCH A `statement_timeout` KILL** — PL/pgSQL's `OTHERS` excludes `QUERY_CANCELED` (57014) and `ASSERT_FAILURE`. Every "a killed run still logs / writes 999" handler in this estate was blind to the one failure it exists for (R118: 35 rewritten). **A record-and-exit handler says `WHEN query_canceled OR OTHERS`.** ⛔ **Only where everything after the catch is bounded by construction** (one upsert, one `log_pipeline_run`, an `EXIT` out of the loop) — the timer is NOT re-armed after the catch, so a loop that swallows-and-continues must stay bare. Prove a fix with the pin's 57014 section (`SET LOCAL statement_timeout = '…ms'` armed as its OWN statement, not inside the block — inline it arms nothing). Instruments: `select jsonb_array_length(check_when_others_timeout_blind())` → `0` (it is a jsonb array — read the length), and `__tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts` reds any migration after `20260920144120` that adds a blind recording handler (escape hatch `-- when-others-timeout-blind: intentional` within 8 lines).
- ⛔ **A drift-guarded (pinned) function must be re-pinned with LITERAL DDL.** `db-invariants-drift-guard` compares the `CREATE OR REPLACE FUNCTION public.<fn>` block in `supabase/tests/<fn>.sql` against the REGISTERED migration, whitespace-normalised — a DO-block `regexp_replace(pg_get_functiondef(...))` rewrite satisfies production and fails the guard. Build the body FROM the pin (prove pin == live first: `md5(trim(regexp_replace(prosrc,'\s+',' ','g')))` both sides), and `db-pin-points-at-the-newest-defining-migration` means the registration must name the NEWEST migration that defines the function — a later follow-up that redefines it moves the pointer again.
- ⚠ **A stalest-first rotation stamps `clock_timestamp()`, never `now()`.** `now()` is the transaction start, always older than the loop's `clock_timestamp()` cursor, so "pick the stalest row" re-picked the same row **9,074 times** in one control before the budget ended. The pin now asserts one rotation fills every slice exactly once.
- ⚠ **`cron_heavy` cannot own tables and has NO table SELECT** — a raw query as that role fails `permission denied for table …`. Create objects as `postgres`, reach them from cron_heavy only through SECDEF functions, and run controls for a cron_heavy job THROUGH the function (`run_thp_leg_logged` via a one-off `zz-*` job), never as `postgres`.
- ⚠ **`CREATE INDEX CONCURRENTLY` as `postgres` dies at the 120 s default under this week's contention even on a 35 MB partition**, leaving `indisvalid=false`; clear it with a one-off pg_cron `DROP INDEX CONCURRENTLY IF EXISTS …` (single statement). Before reaching for a covering index on a 600 s reader, try the shape that has worked five times: partition the read by time, store the closed slices, probe the live one.
- ⚠ **The MCP client caps a statement at 60 s** — an in-migration A/B or a 4-scan set-diff will not fit. Hand A/B with literal `ARRAY[...]::uuid[]`; set-diff via `WITH a AS MATERIALIZED, b AS MATERIALIZED`. A jsonb literal inside a DO block needs quotes (`'{…}'::jsonb`).
- ⭐ **The DB-invariant suite runs locally** (throwaway Postgres 16 on :5433 — recipe in `docs/reference/tooling-gotchas.md`): `DATABASE_URL=… bash scripts/run-db-tests.sh`, one pin with `psql -v ON_ERROR_STOP=1 -q "$DATABASE_URL" -f supabase/tests/<fn>.sql`, and `bash scripts/check-migration-sql-parses.sh`. Run them before the push, not after CI does.

## After applying

17. **Verify, then write conclusions in a SEPARATE step.** Never fire the migration and the verifying query (or a doc capturing the result) in the same batch — the doc captures the assumed result, not the actual output. Run → read → then record.
18. Re-run the relevant catalog check (RLS on base tables, no anon write on base tables, no anon EXECUTE on destructive fns, `security_invoker` on new views). The `rpc-security-drift` artifact runs all of these.
19. 🚨 **Log it in `docs/sessions/<YYYY-MM>.md` (PREPEND, newest-first) + `docs/overnight/ledger.md`, with the exact revert command. ⛔ NOT in `CLAUDE.md` — this line said "CLAUDE.md Recent sessions" until 2026-08-24 and that has been WRONG since the 2026-08-17 restructure.** CLAUDE.md's own rule is *"write new ones into `docs/sessions/`… **never here**"*, and the file runs within tens of characters of a **hard 40,000-character memory-file ceiling** — appending a session entry there can push it over, at which point the whole file is flagged and stops being trustworthy context. `__tests__/claude-md-stays-under-the-memory-file-limit.test.ts` guards the ceiling, but this skill was actively directing the harmful edit. ⚠ **Ledger discipline:** re-read it from disk immediately before writing (it is append-at-top and sessions write it concurrently) and splice at a line-start `^### `.
20. **Cowork deploy-split:** a migration/edge-function ships live from Cowork, but any paired route/.tsx change can't be pushed from here — package it with the `rpc-handoff` skill.
