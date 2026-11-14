# Claude Code → Cowork: apply the Candy edition-key aliases (#247) — SQL editor, then the repo half, then the schedule

**Filed:** 2026-11-13 ~4:20 PM PT by Claude Code cloud. **Owner:** Cowork (Chrome → Supabase SQL editor; repo push). **Severity:** MEDIUM (data accuracy: Candy counts / floors / holders / FMV split across duplicate keys).
**Why Cowork:** Claude Code's `apply_migration` raised Supabase's destructive-statement question twice (~3:55 and ~4:15 PM PT 11-13; the `drop trigger if exists` lines, which drop nothing — none of the triggers exist) and both went unanswered within the tool's 60 s — **nothing was applied** (verified both times: no table, no triggers, no `schema_migrations` row). Trevor, 11-13: "Yes do it" → "Hand it to cowork."

**Staged files (in the repo):**
- `docs/proposals/candy-edition-key-aliases-STAGED.sql` — the migration (header explains everything). New objects only: 1 table, 4 functions, 4 triggers. Fills NO aliases and schedules nothing.
- `docs/proposals/candy-edition-key-aliases-REPO-STAGED.patch.txt` — the code half: `lib/candy/edition-key-aliases.ts` (new), the census resolving aliases, census tests (+3), the DB pin `supabase/tests/candy_edition_key_aliases.sql` (new), 4 drift-guard entries. Uses the placeholder version `20991231000000`. `git apply --check` passed against `b9a3eae53`; with the migration file in place, `npm run preflight` passed 8/8 (incl. DB-invariant SQL tests).
- `docs/proposals/candy-edition-key-aliases-CRON-STAGED.sql` — the second half: first alias fill + two pg_cron jobs. **Run only after the code is live.**

**What it fixes (#247, re-sized 11-13):** one Candy card stored under several edition keys (on-chain name cut at 32 chars, the cut moving with the serial's digit count; full-title keys from the off-chain JSON; old "walk-off"/"walkoff" slugging). Grouping by (collection prefix, tier, circulation, art URL): **1,828 groups / 2,068 redundant keys / ~205k holdings** on non-canonical keys, in MLB and DC collections. Canonical = the most-held key (fewest rows move), then the longest. Triggers rewrite an alias on every write (holdings, Candy sales, listings, offers); `candy_apply_edition_key_aliases` moves existing rows in batches; the census resolves aliases in code so its repoint does not flap.

## 1. Pre-check (stop if any value differs)

```sql
SELECT to_regclass('public.candy_edition_key_aliases') AS tbl,                                   -- NULL
  (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%canonical_edition%') AS trgs,              -- 0
  (SELECT count(*) FROM pg_proc WHERE proname IN ('refresh_candy_edition_key_aliases','candy_apply_edition_key_aliases',
     'candy_canonical_edition_key_trg','candy_canonical_edition_id_trg')) AS fns;                  -- 0
```

## 2. Apply (paste the WHOLE staged file, then the history row, as ONE run; confirm the "destructive operation" dialog)

Paste `docs/proposals/candy-edition-key-aliases-STAGED.sql`, then append:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<UTC YYYYMMDDHHMMSS of the run>', 'audit_20261113_candy_edition_key_aliases');
```

## 3. Post-check

```sql
SELECT to_regclass('public.candy_edition_key_aliases') AS tbl,                                   -- candy_edition_key_aliases
  (SELECT count(*) FROM candy_edition_key_aliases) AS aliases,                                    -- 0 (filled in step 5)
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgname LIKE '%canonical_edition%') AS trgs,
     -- candy_listings_canonical_edition_id_trg,candy_offers_canonical_edition_id_trg,sales_candy_canonical_edition_id_trg,wmc_candy_canonical_edition_key_trg
     -- (sales is partitioned: the trigger name may also appear once per partition — fine)
  (SELECT bool_or(has_function_privilege('anon', p.oid, 'execute')) FROM pg_proc p
    WHERE proname IN ('refresh_candy_edition_key_aliases','candy_apply_edition_key_aliases')) AS anon_exec;  -- false
```

## 4. Repo half (ledger entry FIRST, code commit as the tip so Vercel deploys)

1. Ledger entry (date · migration `<VERSION>` applied: table + 4 functions + 4 triggers, no aliases yet · revert: drop the 4 triggers, functions, table).
2. `git mv docs/proposals/candy-edition-key-aliases-STAGED.sql supabase/migrations/<VERSION>_audit_20261113_candy_edition_key_aliases.sql`
3. `git apply docs/proposals/candy-edition-key-aliases-REPO-STAGED.patch.txt && git rm -q docs/proposals/candy-edition-key-aliases-REPO-STAGED.patch.txt`
4. `sed -i 's/20991231000000/<VERSION>/g' __tests__/db-invariants-drift-guard.test.ts supabase/tests/candy_edition_key_aliases.sql` — then `grep -rn 20991231000000 __tests__ supabase` must print nothing.
5. `npm run preflight` (8/8 expected), commit "candy: one canonical edition key per card (#247)", push. Confirm the Vercel production deploy for THAT commit is READY.

## 5. Schedule (only after step 4's deploy is READY)

Run `docs/proposals/candy-edition-key-aliases-CRON-STAGED.sql` in the SQL editor. The first line returns `{"ok":true,"groups":~1828,"aliases_added":~2068}`. Then add the repo record: a migration file `supabase/migrations/<UTC>_audit_20261113_candy_edition_key_aliases_schedule.sql` with the staged file's contents + its `schema_migrations` row (same pattern as the 11-12 schedule re-applies), `git rm` the staged file, ledger entry (jobnames + revert = `cron.unschedule` both).

## 6. Watch

- `SELECT started_at AT TIME ZONE 'America/Los_Angeles', ok, extra FROM pipeline_runs WHERE pipeline = 'candy-edition-key-alias-apply' ORDER BY started_at DESC LIMIT 3;` — `wmc_moved` ~3,000 per tick, `wmc_left` falling to 0 in ~6 h; `sales_moved` / `offers_moved` non-zero only on the first tick (~25 / ~95).
- The next `candy-collections-census` row: `ok`, `cards` ~98.9k, and `wmc_repointed` NOT ~equal to the aliased holdings it walked (a flap would show as thousands of repoints every run).
- After `wmc_left` = 0: the same-art grouping returns groups only for keys born since the last refresh; then update #247 in `known-issues.md` (alias editions stay as empty rows; whether to delete them is a later call — sales/FMV references on them were moved).
- If anything looks wrong: `SELECT cron.unschedule('rpc-candy-edition-key-alias-apply');` stops the move; the triggers only ever rewrite to a canonical of the SAME card.
