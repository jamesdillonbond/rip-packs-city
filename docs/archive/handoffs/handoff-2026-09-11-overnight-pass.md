# Overnight autonomous pass — 2026-09-11 (01:0x–01:3x PT)

> **GIT PUSH UNAVAILABLE — DB-read + local-only this run.** The sandbox bash/clone mount failed identically to the prior two cloud runs (Windows Sept‑8 update: Plan9 share `c` not mounted). No git clone, no push, and I could not even run `git`/`vitest`/`tsc`. Supabase (read + DDL), Vercel, Sentry, Cowork artifacts and file reads on the mount all worked. **Nothing was shipped.** This handoff, the ledger entry and `metrics-latest.json` are written to the mount **uncommitted** — commit them from the desktop and run the three ledger guards there.

Real local time established from the DB (`select now()` = 08:0xZ, corroborated by `max(ingested_at) FROM sales` = 08:00Z fresh): **01:0x PT — genuine overnight window.** Prior `.lock` was RELEASED (17:42 PT monitor run, took no action); I took over.

## Headline

**Health is GREEN.** Security clean, trust arms fresh, boards fresh, prod serving. One **real instrument‑perf regression** found and fully diagnosed but **queued, not shipped** (it re‑declares a live SECURITY DEFINER function and I cannot run CI this session). Two long‑open scheduler questions moved in the right direction: **the GHA Dead‑Lane Backstop schedule has now self‑fired for the first time** (open test resolved POSITIVE).

## Section 2 — health-drift triage

`rpc_ops_snapshot()` itself **times out** (57014) inside its `board_mv_refresh_max_stale_hours` leg — see the queued fix. I drilled the legs individually instead.

- **Security:** clean. `pg_tables rowsecurity=false` → 0 rows; anon/authenticated write-grant-on-RLS-off → 0 rows; `check_secdef_anon_execute_violations()` / `check_public_security_invariants()` → `[]`.
- **Trust health:** `v_rpc_trust_health_freshness` — every arm `is_stale:false` (ages 0.34–5.34h); precompute is running. Boards themselves are fresh: computed the board‑MV staleness arm directly (single‑pass form) → max **2.11h** (`mv_topshot_market_index_daily`), all 8 watchlisted MVs well under breach. **The snapshot timeout masks no real breach.**
- **Pipelines (`detect_stalled_pipelines` / `get_pipeline_alerts`):**
  - `snapshot-pack-asks` (medium) + `golazos-listings-indexer` (info) `cron_silent` ~38–49 min vs a 5‑min cadence — the **cron‑job.org freeze** persists; lanes are alive only on the slow GHA floor.
  - `fmv-backfill` 58.3% and `price-snapshots` 33.3% failure (statement timeout) — **known chronic, wasteful‑not‑broken**, route logic (off‑limits).
  - `pack_distributions` "data_stale 8 days" (medium) — **benign**: the table's `updated_at` is 1.9h fresh (5,529 rows); the alert reads a pack‑drop‑recency field, and no new packs have dropped. Product‑driven, not a pipeline fault.
  - Atlas 403 arms, `flow-rest-moment-moved-400`, `unmapped-sales-nfl_all_day` (33,835 open, ~28.8d to clear) — all known/benign/info.
  - **`ingest-topshot-challenges` silent 3 days** (since 09‑08 08:10Z, *predating* the freeze). Its **only** `pipeline_runs` row ever is that one failure: `Top Shot GQL HTTP 530: error code 1033` (Cloudflare origin error). Single upstream transient on a low‑frequency/event‑driven lane; **low‑confidence watch**, route logic → queued.
- **Vercel:** healthy. `live:false` is the known healthy‑estate false signal (prod serves via the deployment alias; runtime logs show requests on `dpl_6DuWRNVyxZif4Phg7RyrH584d4Jo` as recently as 08:15Z). The **latest production deployment reads `CANCELED`** — it is the **docs‑only session‑log commit** from last night's interactive pass ("docs(session): close out the night…"); `ignoreCommand` correctly cancels a docs‑only tip. **Not a P0.** The #76 spend‑cap pause is resolved.
- **Runtime errors (24h):** overwhelmingly the **chronic** classes — DB statement‑timeouts on edition/pack‑detail/team/insights RPCs (IO saturation), wallet‑backfill Cadence `computation limit exceeded` (upstream), sniper‑feed AD GQL 403. One **new** item worth a fix: **`/api/sentinel` Telegram send failed `400 message is too long`** at 00:01Z — an alert fired but the outgoing Telegram message exceeded 4096 chars and was dropped. The alerting channel silently loses oversized alerts. Route logic → queued.
- **Sentry:** SDK is OFF since 08‑18 (#34, decided no‑spend) — not re‑checked as a source of new prod events.
- **Artifacts:** 11 enumerated (`list_artifacts`), none flagged broken in the inbox; none repaired (task rule: don't regenerate working artifacts).

### Post-ship regression watch (last 24–48h ships — all interactive Claude Code)
- `rpc_gha_schedule_watchdog()` verdict‑order fix → live call returns **`delivering`, `gha_schedule_stalled:false`**. Healthy, **no regression**.
- `rpc-wmc-fmv-populate-backstop` reschedule (`4,24,44`) and the `20260911053500` marker fix → lanes alive, function anon/auth EXECUTE `false` as intended. No regression detected (CI not runnable here).

### Open watch items — status
- ✅ **"Does the Dead‑Lane Backstop GHA `schedule` ever self‑fire?"** → **YES.** First `dead-lane-backstop-heartbeat` carrying `extra.event='schedule'` landed **07:28:40Z**. The dead lanes are now kept alive by the automatic backstop, not only by hand. Downgrades the urgency of the operator action from "lanes will die" to "lanes are on a slow ~hourly floor."
- ⏳ `rpc-topshot-onchain-rekey` second‑timeout watch — its next slot (11:33Z 09‑11) had not yet fired at run time; carry forward.

## Shipped
**None.** (NO‑PUSH; the one real fix is a live‑instrument function replace — queued below.)

## Queued — needs a CI‑capable (desktop/Claude Code) session

> ✅ **ALL THREE DISPOSITIONED 2026-09-11 ~02:35 PT by the CI-capable session this section asked for. Do NOT re-queue them.**
> - **Q1 — SHIPPED.** Migration `20260911091415_perf_board_mv_refresh_max_stale_hours_single_pass_scan`. Equivalence proven per-watchlist-row (8/8 identical), cost measured on BUFFERS by the same instrument on both sides: **150,601 → 18,759 reads (8.0×)**. ⚠ The *timeout* that motivated it was **not reproducible** — the old form ran in 970 ms on a warm cache — so it shipped justified on buffers, and the migration header says so.
> - **Q2 — STALE, nothing to do.** The Telegram `400 message is too long` at 00:01Z **predates its own fix by 13 minutes**: `lib/telegram-message.ts` landed `26ec426d9` at **00:14:44Z**. Every sentinel run since (00:20, 00:23, 00:47, 03:08, 05:01Z) reports a clean `"telegram"`, including 20-check payloads, and the bound is unit-proven in 11 cases — one of which **reproduces the live failure**. ⭐ The pass swept "runtime errors, 24 h" and caught an event from *before* the fix; a 24-hour error window will do that whenever a fix lands inside it.
> - **Q3 — FALSE POSITIVE, and the lane is silent ON PURPOSE.** `ingest-topshot-challenges` was **deliberately unscheduled 2026-09-08** (`62a092ae6`) because it fires into the dead `public-api.nbatopshot.com` (530 / CF 1033 since ~08-28). Its route header records the retirement, the evidence and the re-enable condition; `__tests__/topshot-gql-dead-host-crons-are-retired.test.ts` **pins it** and passes 7/7. "Silent 3 days" *is* the intended state, and the 3 days date from the retirement itself. ⭐ **A lane with a single failing `pipeline_runs` row and nothing since can be a RETIREMENT rather than a breakage — check `vercel.json` and the route header before filing.**

### Q1 — `board_mv_refresh_max_stale_hours()` single‑pass rewrite  *(the night's primary finding — READY migration)*
Root cause, fully measured: the function runs a correlated subquery **once per active watchlisted MV** (8 today), each a **Parallel Seq Scan of `cron.job_run_details`** (261,557 rows, oldest 2026‑07‑09; the table has **only a `runid` pkey**, no `jobid` index). EXPLAIN ANALYZE: one MV = ~18,858 buffers / ~9.9s → 8× + IO contention now exceeds the 120s cap intermittently, timing out **`rpc_ops_snapshot()`** and the live **`v_rpc_trust_health`** board‑MV arm. ~5h earlier it still completed (interactive pass read trust 38/38 at 20:43 PT) — a **row‑count threshold crossing**, not a new breach.

- **An index was the first choice and is blocked:** `CREATE INDEX CONCURRENTLY … ON cron.job_run_details (jobid,status,end_time)` → `42501 must be owner of table job_run_details` (pg_cron‑owned). So the fix is a value‑equivalent function rewrite that scans the big table **once** via a `MATERIALIZED` CTE.
- **Why queued, not shipped:** it re‑declares a live SECURITY DEFINER instrument function. In NO‑PUSH mode `apply_migration` would leave `migration-parity` **red** until `migration-autorecover` files it, and I **cannot run** the `migration-new-function-states-its-anon-exec-decision` guard (which reddened `main` on this exact operation < 24h ago). Verified in prod that the rewrite returns the identical 8 rows (max 2.11) and completes in ~10s; no test pins the function body (grep: only migrations/docs).
- **Ship it as one migration** (marker matched to the current CI‑passing convention; do **not** add a REVOKE — `CREATE OR REPLACE` does not reset the ACL):

```sql
-- perf_board_mv_refresh_max_stale_hours_single_pass_scan
-- anon-exec: unchanged — board_mv_refresh_max_stale_hours is ALREADY revoked in prod (anon EXECUTE false, authenticated EXECUTE false, verified 2026-09-11 with has_function_privilege, not acl text); CREATE OR REPLACE does not reset the ACL. (board_mv_refresh_max_stale_hours)
CREATE OR REPLACE FUNCTION public.board_mv_refresh_max_stale_hours()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
  WITH last_ok AS MATERIALIZED (
    SELECT jobid, max(end_time) AS last_end
    FROM cron.job_run_details
    WHERE status = 'succeeded'
    GROUP BY jobid
  )
  SELECT COALESCE(max(stale_h), 0)::numeric
  FROM (
    SELECT EXTRACT(epoch FROM (now() - COALESCE(
             (SELECT max(l.last_end)
                FROM cron.job j
                JOIN last_ok l ON l.jobid = j.jobid
               WHERE j.active
                 AND j.command ILIKE '%' || w.matview_name || '%'),
             w.watchlisted_at
           ))) / 3600.0 AS stale_h
      FROM public.board_mv_refresh_watchlist w
     WHERE w.is_active
  ) s;
$function$;
```
- **Revert:** re‑apply the body from `20260802152023` (correlated subquery, `/3600`, COALESCE‑to‑watchlisted_at). **Verify after:** `SELECT rpc_ops_snapshot()` completes; `SELECT * FROM v_rpc_trust_health WHERE status<>'ok'` returns without timeout; value matches 2.11±.
- **Durable root‑cause companion (needs a policy call):** `cron.job_run_details` has **no retention** (261k rows / 2 months). A prune (e.g. keep 14–30d) would also fix this and is the real long‑term lever — but it's a bulk `DELETE` on a pg_cron‑owned table → destructive, not autonomous.

### Q2 — Sentinel Telegram "message too long" (route logic)
`/api/sentinel` sent a Telegram alert at 00:01Z that Telegram rejected `400 … message is too long` (4096‑char cap). The alert was silently lost. Fix: chunk or truncate outgoing Telegram messages in the sentinel route (and log a beacon on send‑failure so a dropped alert is itself visible). Off‑limits here (route + I can't push); needs a diff.

### Q3 — `ingest-topshot-challenges` silent 3 days (low confidence)
Only `pipeline_runs` row ever is a 09‑08 upstream `HTTP 530 / 1033`. Confirm whether the caller (cron‑job.org lane?) is firing and simply no‑opping on unchanged challenges, or genuinely dead. Route/ingest logic → not autonomous.

## Carried forward — needs Trevor
- 🚨 **Re‑enable the cron‑job.org jobs** for the ~10 high‑frequency lanes (auto‑disabled across the #76 pause). Now **less urgent** — the GHA backstop self‑fires as of 07:28Z — but it is the only lever that restores the native 5‑minute cadence.
- **`cron.job_run_details` retention** (see Q1 companion) and **Atlas‑events retention** (DB +8.2 GB since 09‑07) — both destructive, need a policy call.
- **#55** two 2‑hourly Routines read `enabled:false`; **#22** credential‑purge GC + rotate.

## Failed / blocked / auto-reverted
None. No verification failure; no auto‑revert (no recent ship regressed).
