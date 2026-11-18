# Handoff → Cowork (Chrome): apply the pack-nft-identity fix — 2026-11-18 ~6:40 AM PT

**From:** Claude Code cloud (Sentinel WARN thread, 11-17 9:04 PM PT). **For:** Cowork, using Chrome on the Supabase dashboard.
**Why it is handed off:** both `apply_migration` attempts (11-17 ~10:00 PM PT and 11-18 ~6:25 AM PT) stopped on Supabase's confirmation prompt, which nobody answered within 60 s. Nothing was applied: live `md5(prosrc)` is still the old body.

This is item **A** of [handoff-2026-11-18-overnight-pass.md](handoff-2026-11-18-overnight-pass.md). Same diagnosis, same fix, now committed as a file.

## What is broken

`rpc-pack-nft-identity-lane` (pg_cron, every 5 min, `SELECT public.run_pack_nft_identity_lane();`) has failed **every tick since ~5:00 PM PT 11-17**:

```
ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time
CONTEXT: INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
```

- `collect_pack_nft_identity()` requeues packs from a failed Studio request using `pack_purchases UNION ALL pack_rips`. A pack that was bought and then ripped shows up in both, so one key is offered twice.
- That path only runs when a Studio request fails, so it stayed hidden until Dapper Studio started returning HTTP 530 (~4:23 PM PT 11-17).
- The abort rolls back the whole collector, so failed requests are never marked collected and **every tick dies on the same rows. The lane will NOT recover when Studio comes back.**
- Last `pipeline_runs` row for `pack-nft-identity`: 4:58 PM PT 11-17. Uncollected requests: 86 at 10 PM PT, **242 at 6:24 AM PT 11-18**.

## The fix (already committed)

`supabase/migrations/20261118055831_audit_20261117_pack_identity_requeue_collapses_bought_and_ripped_duplicates.sql`

Both requeue inserts add `GROUP BY k.collection_id, k.pack_nft_id` and take `max(k.at)`. Nothing else changes. Compared with the base `20260920185051_…`, the only diff is two GROUP BYs plus comments. Preflight was green (tsc, ci:guards, lint:ratchet, 243 guard files / 2832 tests, migration parse).

| | md5(prosrc) |
|---|---|
| live now (base) | `9217c411a9e17fc38e8508947f6bd362` |
| expected after apply | `51a46709aafd22ce1cc9dd63982c036a` |

## Steps (Chrome, Supabase dashboard → project `bxcqstmqfzmuolpuynti` → SQL Editor)

1. **Pre-check: the base must still be live.** A `CREATE OR REPLACE` writes the whole body, so if someone changed it since, stop:
   ```sql
   select md5(prosrc) from pg_proc where proname = 'collect_pack_nft_identity';
   ```
   It must be `9217c411…`. If it is `51a46709…`, the fix is already applied: skip to step 4. Anything else: stop, and do not apply. Diff the live body against the file and report back.
2. **Paste the WHOLE migration file** into a new query. Take it from GitHub: `main` → the path above → Raw. Run it. Expect "Success. No rows returned".
3. **Post-check:** re-run the step-1 query and expect `51a46709aafd22ce1cc9dd63982c036a`. Also confirm the ACL did not change:
   ```sql
   select has_function_privilege('anon', 'public.collect_pack_nft_identity()', 'execute') as anon_exec;  -- false
   ```
4. **Watch the next tick (≤5 min):**
   ```sql
   select d.status, d.start_time, left(d.return_message, 120)
   from cron.job_run_details d join cron.job j using (jobid)
   where j.jobname = 'rpc-pack-nft-identity-lane' order by d.start_time desc limit 3;

   select started_at, ok, rows_found, error, extra
   from pipeline_runs where pipeline = 'pack-nft-identity' order by started_at desc limit 3;

   select count(*) from pack_nft_identity_requests where collected_at is null;  -- should fall sharply
   ```
   **Pass:** the cron run is `succeeded` and a new `pipeline_runs` row exists.
   ⚠ While Studio still returns 530, that row will read `ok=false` with `requests_failed > 0` and a 530 `error`. **That is the correct, honest outcome, not a regression.** The defect was the abort, not the failed requests. The `requeued` count in `extra` shows the dedup path ran.
5. **Ledger:** add an entry at the top of the 11-18 section in `docs/overnight/ledger.md`: applied time (PT), post-check md5, first green tick. Revert path: re-apply the function body from `20260920185051_audit_20260920_pack_page_dedup_tests_in_flight_not_merely_dispatched.sql`.

## Do NOT

- Do not use the Supabase MCP `apply_migration` for this unless you can answer its prompt. If you do use it, it records a new version: rename the committed file to the version it records (`select version, name from supabase_migrations.schema_migrations order by version desc limit 3`, then `git mv`, content untouched). The SQL Editor path records no row, so the committed file stays as it is, and `migration-parity` (applied → file) stays green either way.
- Do not "fix" the failing pack lanes (pack sales / opens / EV / asks). They are Dapper Studio 530 (#218), upstream.

## Other items from this thread: status at handoff (6:30 AM PT 11-18)

- **All Day dist totals** (overnight item C, null `total_opened`): `rpc-sync-allday-pack-dist-totals` **succeeded** at 6:24 AM PT. It cleared by itself as the overnight pass predicted. The durable one-predicate fix is still queued there (drift-guard pinned, collision-gated). Not touched.
- **Candy sales indexer** (overnight item B): the 4:20 AM PT run was `ok=true` (0 rows written) after four failed runs. The later-set isolation fix is still queued there. Not touched.
