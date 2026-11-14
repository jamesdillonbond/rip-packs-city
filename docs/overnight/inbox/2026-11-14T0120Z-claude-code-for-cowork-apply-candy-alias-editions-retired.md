# Claude Code → Cowork: apply the #247 alias-edition retirement (SQL editor), then the repo half

**Filed:** 2026-11-13 ~5:20 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → Supabase SQL editor; repo push). **Severity:** LOW (cosmetic/duplicate tiles; nothing wrong is being written).
**Why Cowork:** `apply_migration` raised Supabase's destructive-statement question twice (~5:10 and ~5:17 PM PT 11-13 — the DELETEs inside the new function body) and both went unanswered within the tool's 60 s — **nothing was applied** (verified: 0 functions, no trigger, no cron row, no `schema_migrations` row). Trevor, 11-13: "Hand it to cowork."

**Staged files (in the repo):**
- `docs/proposals/candy-alias-editions-retired-STAGED.sql` — the migration (header explains it). Creates 2 functions, 1 trigger, 1 pg_cron job. Deletes nothing itself; the cron does, one row per statement.
- `docs/proposals/candy-alias-editions-retired-PIN-STAGED.sql.txt` — its DB pin, passed on scratch Postgres; a planted defect (the still-held check removed) reds it.

**Why:** #247 (applied earlier by you, `20261114002600`) moves every holding / sale / listing / offer of a Candy card onto its canonical key, but the 2,935 alias `editions` rows stay and list on set pages (`get_set_editions`) as duplicate tiles with nothing held. This retires them: a BEFORE INSERT trigger skips re-creating an alias key, and `candy_delete_emptied_alias_editions(500)` deletes an alias edition nothing references (its `candy_edition_market_daily` / `fmv_snapshots` rows first; a holding, sale, listing, offer, wishlist, watchlist, pack-pool or special-serial reference keeps it; a NO ACTION FK is counted, never forced). Prerequisites already live: the sales indexers resolve an alias key through its canonical (`87080eea`, READY) and an alias URL 308s to the canonical page (verified on prod).

## 1. Pre-check (stop if any value differs)

```sql
SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('candy_skip_alias_edition_insert','candy_delete_emptied_alias_editions')) AS fns,   -- 0
       (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-candy-alias-editions-retired') AS cron,                                     -- 0
       (SELECT count(*) FROM candy_edition_key_aliases) AS aliases,                                                                    -- ~2,935
       (SELECT extra->>'wmc_left' FROM pipeline_runs WHERE pipeline = 'candy-edition-key-alias-apply' ORDER BY started_at DESC LIMIT 1) AS wmc_left;  -- any; 0 by ~6 PM PT
```

`wmc_left` > 0 is fine: an alias edition that still holds a card is skipped until the move job empties it.

## 2. Apply (paste the WHOLE staged file, then the history row, as ONE run; confirm the "destructive operation" dialog)

Paste `docs/proposals/candy-alias-editions-retired-STAGED.sql`, then append:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261113_candy_alias_editions_retired');
```

## 3. Post-check

```sql
SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'editions_candy_skip_alias_insert_trg') AS trg,                        -- 1
       (SELECT schedule FROM cron.job WHERE jobname = 'rpc-candy-alias-editions-retired') AS sched,                            -- 7,22,37,52 * * * *
       (SELECT bool_or(has_function_privilege('anon', p.oid, 'execute')) FROM pg_proc p
         WHERE proname IN ('candy_skip_alias_edition_insert','candy_delete_emptied_alias_editions')) AS anon_exec;              -- false
```

Optionally run one batch by hand and read it: `SELECT public.candy_delete_emptied_alias_editions(500);` → `deleted` ≤ 500, `referenced` small.

## 4. Repo half (ledger entry FIRST; code commit last)

1. Ledger entry (date · `<VERSION>` applied: skip-alias-insert trigger + delete function + cron · revert: `DROP TRIGGER editions_candy_skip_alias_insert_trg ON editions; SELECT cron.unschedule('rpc-candy-alias-editions-retired');`).
2. `git mv docs/proposals/candy-alias-editions-retired-STAGED.sql supabase/migrations/<VERSION>_audit_20261113_candy_alias_editions_retired.sql`
3. `git mv docs/proposals/candy-alias-editions-retired-PIN-STAGED.sql.txt supabase/tests/candy_alias_editions_retired.sql` and replace `<version>` in its header with `<VERSION>`.
4. Add two entries to `PINS` in `__tests__/db-invariants-drift-guard.test.ts` (fns `candy_skip_alias_edition_insert` and `candy_delete_emptied_alias_editions`, test `supabase/tests/candy_alias_editions_retired.sql`, migration the file from step 2).
5. `npm run preflight` (DB-invariant tests included), commit "db: retire emptied Candy alias editions (#247)", push; mark this filing ✅ in `INDEX.md`.

## 5. Watch

- `SELECT started_at AT TIME ZONE 'America/Los_Angeles', extra FROM pipeline_runs WHERE pipeline = 'candy-alias-editions-retired' ORDER BY started_at DESC LIMIT 3;` — `alias_editions_left` falling to ~0 within a few hours of the move job's `wmc_left` reaching 0; `referenced` near 0 (if not, read which FK — do not force).
- Then close #247 in `docs/reference/known-issues.md` (prepend a CLOSED line to its body, run `npm run docs:issues-index`, check the diff is one row).
