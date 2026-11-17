# Handoff → Cowork: apply two staged SQL migrations (2026-11-09, Claude Code cloud)

**Why Cowork:** Claude Code's `apply_migration` raised a Supabase confirmation prompt that never
reached Trevor (Trevor, 11-09: "Supabase prompts don't seem to go through for sql stuff like this.
Hand it off to cowork"). Nothing below is in production yet. Use the **dashboard SQL editor in
Trevor's Chrome** — the 11-08 route (ledger, "Cowork SQL-editor drain").

Both changes are built, pinned and tested: the #242 pin passed on a local Postgres with 2 planted
defects red, and the repo half is one tested command. Detail and measurements:
`docs/reference/known-issues.md` #242 (11-09 entry), `docs/overnight/inbox/2026-11-09T2211Z-…` (both ↳ sections),
`docs/proposals/STAGED-2026-11-09-README.md`.

| # | File (fetch from `main`) | SHA-256 | What it fixes |
|---|---|---|---|
| A | `docs/proposals/rip-metadata-eligibility-precomputed-STAGED.sql` | `d11172aa03cbe1284def95b2706f7e607da5c0ca55545585550b87e30151b2e5` | #242 `backfill_pack_rip_metadata` timing out 6 of 15 hours: two whole-set eligibility legs (~19 s fixed) move to a queue refreshed every 2 h; queued rows re-checked per call |
| B | `docs/proposals/wmc-selfheal-skips-candy-STAGED.sql` | `6f003ab4370be822b1848b0703f221c71eddbbf8105ad63107556baf0428d648` | `rpc_wmc_selfheal_recent` (pg_cron 726) skips Candy + writes only fillable rows (388 ms vs a 110 s timeout); pg_cron 818 (Atlas reconcile) gets a 300 s timeout |

## 1. Pre-check — the bases have not moved (run first; stop if any line differs)

```sql
SELECT
  (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'backfill_pack_rip_metadata')  AS a_base,    -- 4eea621392b1f2ba77c50df91fccbbec
  (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'rpc_wmc_selfheal_recent')     AS b_base,    -- de2a5ae6a02fe38b43ea11635771664c
  to_regclass('public.pack_rip_backfill_eligible')                                 AS a_table,   -- NULL
  (SELECT command FROM cron.job WHERE jobid = 818)                                 AS b_cron;    -- SELECT public.reconcile_topshot_map_with_atlas(500)
```

If a base md5 differs, another session changed that function after 11-09 4:30 PM PT: do NOT apply
that file (it is a full-body replace and would revert their change) — file it back to Claude Code.

## 2. Apply — each file whole, one Run per file

1. Fetch the file from `main` and **check its SHA-256 against the table** before pasting (same as
   11-08). Paste the WHOLE file, comments included, and Run.
2. A "Potential issue detected" dialog is expected (A has a `DELETE` inside a function body and
   `REVOKE`s; B alters a cron job). Confirm it.
3. **A** runs one queue refresh inline (~20–60 s). Do not run A between :50 and :56 past the hour
   (the backfill's own :53 call). B is instant.
4. Record each, with the UTC time you ran it as the version (14 digits):

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('<A_VERSION>', 'audit_20261109_rip_metadata_eligibility_is_precomputed'),
  ('<B_VERSION>', 'audit_20261109_wmc_selfheal_skips_candy_and_writes_only_what_it_can_fill');
```

## 3. Post-check (expected values in comments)

```sql
SELECT
  (SELECT count(*) FROM public.pack_rip_backfill_eligible)                               AS queued,         -- > 0 (a few hundred)
  (SELECT extra FROM pipeline_runs WHERE pipeline = 'pack-rip-backfill-eligible-refresh'
     ORDER BY started_at DESC LIMIT 1)                                                    AS refresh_run,    -- {"allday":…,"unpriced":…}
  (SELECT schedule FROM cron.job WHERE jobname = 'rpc-pack-rip-backfill-eligible-refresh') AS refresh_cron,  -- 14 */2 * * *
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'pack_rip_backfill_eligible')       AS rls_on,         -- true
  has_function_privilege('anon', 'public.refresh_pack_rip_backfill_eligible()', 'EXECUTE') AS anon_exec,      -- false
  (SELECT md5(prosrc) <> '4eea621392b1f2ba77c50df91fccbbec' FROM pg_proc WHERE proname = 'backfill_pack_rip_metadata') AS a_body_changed, -- true
  (SELECT prosrc LIKE '%209ade70-32c5-4470-bc7c-4793d660f713%' FROM pg_proc WHERE proname = 'rpc_wmc_selfheal_recent')  AS b_skips_candy,  -- true
  (SELECT command FROM cron.job WHERE jobid = 818)                                        AS b_cron;         -- SET statement_timeout = '300s'; SELECT public.reconcile_topshot_map_with_atlas(500)
```

Optional (heals the 1,455 non-Candy rows the lane missed on 11-09, ~0.4 s): `SELECT public.rpc_wmc_selfheal_recent(3);` — expect a number > 0 and a `wmc-metadata-selfheal` row with ok=true.

## 4. Repo half — one command (tested 11-09 with dummy versions: drift guard 371/371, pin PASS on Postgres, a re-run refuses)

```bash
git pull --ff-only origin main
node scripts/finish-staged-2026-11-09.mjs <A_VERSION> <B_VERSION>
npx vitest run __tests__/db-invariants-drift-guard.test.ts   # must be all green
git rm scripts/finish-staged-2026-11-09.mjs
```

It moves A and B into `supabase/migrations/` under their versions (migration-parity keys on the
version), installs the updated `supabase/tests/backfill_pack_rip_metadata.sql` with its pointer set,
re-points the `backfill_pack_rip_metadata` PIN and adds one for `refresh_pack_rip_backfill_eligible`.
Then: ledger entry (date · what shipped · revert path, below), commit the ledger first, then the
migrations commit, push. No app code changes, so no Vercel deploy is needed.

## 5. Watch

- **A:** the next `backfill-pack-rip-metadata` run at :53 — ok=true and `duration_ms` ~19 s lower
  than the 40–50 s it ran on 11-09. `pack-rip-backfill-eligible-refresh` rows every 2 h at :14.
- **B:** 11-10 2:31 AM PT `wmc-metadata-selfheal` and 4:47 AM PT `topshot-map-atlas-reconcile` —
  read their **`pipeline_runs`** rows (ok=true), NOT `cron.job_run_details` (both catch their own
  error, so cron says `succeeded` even when they time out).

## Revert

- **A:** re-apply `backfill_pack_rip_metadata` from
  `supabase/migrations/20261102201245_audit_20261102_8911_rekey_and_unique_pool_vote.sql`;
  `SELECT cron.unschedule('rpc-pack-rip-backfill-eligible-refresh');`
  `DROP FUNCTION public.refresh_pack_rip_backfill_eligible(); DROP TABLE public.pack_rip_backfill_eligible;`
- **B:** re-apply `rpc_wmc_selfheal_recent` from
  `supabase/migrations/20260920143546_audit_20260920_r118_batch_two_sixteen_unpinned_record_and_exit_handlers_catch_query_canceled.sql`;
  `SELECT cron.alter_job(818, command := 'SELECT public.reconcile_topshot_map_with_atlas(500)');`
