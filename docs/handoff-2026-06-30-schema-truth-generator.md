# Handoff — schema-truth generator (kills the stale-doc footgun class)

**Problem:** volatile schema facts are hand-maintained inline in CLAUDE.md (and the `rpc-data` skill) and drift from the live DB. The dropped `pinnacle_fmv_snapshots` table name alone resurfaced as a live-query footgun across 2026-06-28 and 06-29; "stale/footgun" appears ~100+ times in the ledger/CLAUDE. `rpc-data` also can't be edited from Cowork (Settings > Capabilities only).

**Fix:** generate the volatile facts from `information_schema` on a cadence and diff them against what's written down. **Preferred owner = the weekly `rpc-data-quality-sweep` scheduled task** (it already has Supabase MCP) — no CC code required; alternatively CC can commit it as a small admin route. Steps:

1. Run a fixed fact-pull (read-only) and write `docs/reference/schema-truth.md`:
   - FMV home per collection: confirm `pinnacle_fmv_snapshots` does NOT exist (only the `_backup_20260608`); confirm `pinnacle_fmv_history` + `pinnacle_catalog.fmv_*` are the live Pinnacle FMV; `fmv_snapshots` is TS/AllDay/Golazos/UFC.
   - Existence of every table CLAUDE.md names in its "verify before writing queries" block.
   - Enum values for `fmv_confidence`, `tier_type`, `chain_type` (catch casing drift like MED vs MEDIUM).
   - RLS-on count across public tables (CLAUDE.md asserts "0 rows with rowsecurity=false").
2. Diff the generated facts against the strings inlined in CLAUDE.md + the `rpc-data` SKILL source. Flag drift to `docs/overnight/ledger.md` (Queued); a dropped/renamed table named in CLAUDE.md = HIGH-priority footgun.
3. Thin CLAUDE.md's schema block to point at `docs/reference/schema-truth.md` instead of duplicating the volatile facts (keep only stable conventions: the two collection vocabularies, partitioning, UUIDs).

**Reference SQL (read-only):**
```sql
SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY (ARRAY['pinnacle_fmv_snapshots','pinnacle_fmv_history','pinnacle_catalog','fmv_snapshots']);
SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typname IN ('fmv_confidence','tier_type','chain_type') GROUP BY 1;
SELECT array_agg(tablename) FROM pg_tables WHERE schemaname='public' AND rowsecurity=false;
```

**Revert:** delete `docs/reference/schema-truth.md` + remove the sweep step / route. Docs-only.

**Verify done:** `schema-truth.md` regenerates weekly; a deliberately-stale fact planted in a scratch CLAUDE.md copy is flagged by the diff.
