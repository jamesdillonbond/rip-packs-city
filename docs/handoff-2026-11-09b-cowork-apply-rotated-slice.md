# Handoff → Cowork: #242 second step — read the eligibility queue as a rotated slice (2026-11-09 ~6:05 PM PT, Claude Code cloud)

Same route as `docs/handoff-2026-11-09-cowork-apply-staged-sql.md`: the dashboard SQL editor in Trevor's
Chrome (Supabase confirmation prompts don't reach him from Claude Code).

## Why

The first step (`20261110005700`, which you applied at 4:57 PM PT) moved the two eligibility sets into
`pack_rip_backfill_eligible`. Its first production call (5:53 PM PT) succeeded but took **40.6 s**, against
44.6 s the hour before. EXPLAIN at ~6 PM PT: the unpriced leg still re-checks **every** queued row (33,716
`pack_rips` probes, 11.5 s / 135k buffers cold) just to keep the oldest 75. You flagged exactly this: 34,169
queued rows, about 9.5 s cold.

**Fix:** each queued row now carries its `pack_rips` stamp. Each leg reads only the oldest 4× its share
by that stamp (300 rows for unpriced, 600 for All Day), re-checks those, and rotates every row it read to
now(). A queued row that stopped qualifying can't hold the head. Same predicates and shares, and every
other leg is byte-identical. The pin passes on local Postgres with a new rotation property, and a planted
no-rotation defect fails it.

| File (fetch from `main`) | SHA-256 |
|---|---|
| `docs/proposals/rip-metadata-queue-rotated-slice-STAGED.sql` | `ac9db096deadf38808d54e1ab418ceece22ff230efe35385d9da0c381d75f242` |

## 1. Pre-check (stop if either differs: the bodies moved after 6 PM PT)

```sql
SELECT (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'backfill_pack_rip_metadata')          AS bf,  -- 1808d9233d2fdedc4017e93451767ad3
       (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'refresh_pack_rip_backfill_eligible')  AS rf;  -- 195f927439d1dd5871db2ebea75b3ae4
```

## 2. Apply

SHA-256-check the file, then paste the whole file and Run it in one go. It adds a column, backfills it for
the ~34k queue rows (a few seconds), builds a small index, and replaces both functions. **Not between
:50 and :56 past the hour**, and ideally not at :14 on an even UTC hour (the refresh). Then record it:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('<VERSION>', 'audit_20261109_rip_metadata_queue_is_read_as_a_rotated_slice');
```

## 3. Post-check

```sql
SELECT count(*) FILTER (WHERE stamp IS NULL) AS unstamped,                                        -- 0
       count(*)                              AS queued,                                           -- ~34k
       (SELECT prosrc LIKE '%unpriced_rotate%' FROM pg_proc WHERE proname = 'backfill_pack_rip_metadata') AS new_body, -- true
       to_regclass('public.idx_pack_rip_backfill_eligible_leg_stamp') IS NOT NULL AS idx         -- true
FROM public.pack_rip_backfill_eligible;
```

## 4. Repo half: one command (dry-run tested: drift guard 371/371, pin PASS on Postgres, a re-run refuses)

```bash
git pull --ff-only origin main
node scripts/finish-staged-2026-11-09b.mjs <VERSION>
npx vitest run __tests__/db-invariants-drift-guard.test.ts
git rm scripts/finish-staged-2026-11-09b.mjs
```

Then the ledger entry (ledger commit first), the migrations commit, and push.

## 5. Watch

The next `backfill-pack-rip-metadata` run at :53: ok=true, with `duration_ms` clearly below the 40.6 s
of 5:53 PM PT (the unpriced leg drops from ~11 s cold to well under 1 s). `value_resolved` should stay in
the same few hundred.

## Revert

Re-apply both functions from `supabase/migrations/20261110005700_audit_20261109_rip_metadata_eligibility_is_precomputed.sql`.
The `stamp` column and index can stay; that body ignores them.
