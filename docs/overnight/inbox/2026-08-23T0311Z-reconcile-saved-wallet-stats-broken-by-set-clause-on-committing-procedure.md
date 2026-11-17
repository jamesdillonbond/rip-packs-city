# HIGH-PRIORITY — `reconcile_all_saved_wallet_stats` broken by today's R14 `ALTER PROCEDURE … SET search_path` (a SET-clause procedure cannot COMMIT)

**Filed:** 2026-08-23T03:11Z (rpc-daytime-monitor, ~20:05 PT tick)
**Class:** same-day-ship regression (NOT saturation collateral). Positive control at file time: `io_wait=1 / active=1` — not in a spell, so this cause is interpretable.
**Source:** `check_pgcron_recent_failures()` → `rpc-reconcile-saved-wallet-stats` `latest_status=failed`, `last_fail_message = "ERROR: invalid transaction termination / CONTEXT: PL/pgSQL function reconcile_all_saved_wallet_stats(integer,integer,integer) line 30 at COMMIT"`. Corroborated by `detect_stalled_pipelines()` (pipeline `reconcile-saved-wallet-stats` silent 203 min, medium).

## What broke and why

Today's R14 ship (ledger 2026-08-22, migration `20260823021500`) ran:

```
ALTER PROCEDURE public.reconcile_all_saved_wallet_stats(int,int,int) SET search_path = public;
```

`reconcile_all_saved_wallet_stats` is a **PROCEDURE** (`prokind='p'`) that does transaction control — it **COMMITs per wallet** (the pipeline's own note: "COMMITTING its work per-wallet", error is at `line 30 at COMMIT`). PostgreSQL disallows `COMMIT`/`ROLLBACK` inside a routine that carries an **attached `SET` config clause**. So the moment the ALTER attached `SET search_path=public`, the procedure's first `COMMIT` began raising `invalid transaction termination`. Verified live: `pg_proc.proconfig = {search_path=public}`, `prosecdef=false`, `prokind='p'`.

## Timeline — clean before/after the ship (job runs hourly at :44)

| tick (UTC) | status | message |
|---|---|---|
| 2026-08-22 22:44 | **succeeded** | CALL |
| 2026-08-22 23:44 | **succeeded** | CALL (last good run) |
| 2026-08-23 00:44 | failed | statement timeout (saturation — pre-ALTER body) |
| 2026-08-23 01:44 | failed | statement timeout (saturation — pre-ALTER body) |
| 2026-08-23 02:44 | **failed** | **invalid transaction termination at COMMIT** (first tick after the ~02:15Z ALTER) |

Every post-ALTER tick fails at COMMIT. This is not a timeout; the procedure now errors before it can do any work.

## Blast radius

`reconcile-saved-wallet-stats` (pg_cron jobid 259, hourly) backs the cached saved-wallet cards on the dashboard / `/profile` / `/share`: `cached_moment_count`, `cached_fmv_usd`, `cached_top_tier`. Those values now stop refreshing hourly and will silently go stale until the SET clause is removed. Not a user-facing 500 and not data loss (per-wallet commits mean prior work is retained), but a real ongoing freshness regression on a signed-in surface.

## Suggested action (for the night pass / Trevor — I am read-only and did NOT touch it)

The R14 goal was `search_path` hardening. On a COMMIT-using procedure the attached-`SET` form is the wrong tool. Two options:

1. **Fastest restore:** `ALTER PROCEDURE public.reconcile_all_saved_wallet_stats(int,int,int) RESET search_path;` — removes the clause, COMMIT works again immediately. Loses the hardening.
2. **Keep the hardening correctly:** drop the attached clause (option 1) AND set the path *inside the body* as the first statement — `SET search_path = public;` (or `SET LOCAL search_path = public;`) at the top of the procedure body. A `SET` **statement** in the body does not block transaction control; only the **routine-attached `SET` clause** does. This preserves R14's intent without breaking COMMIT.

🚨 **SECOND INSTANCE CONFIRMED — `rpc_trust_health_precompute_refresh_p` has the identical defect.** R14 also ran `ALTER PROCEDURE … SET search_path` on it. Verified live: `prokind='p'`, `proconfig={search_path=public}`, and its body **contains COMMIT/ROLLBACK** (`prosrc ILIKE '%COMMIT%'` = true). It WILL raise `invalid transaction termination` at its next COMMIT. It did NOT appear in `check_pgcron_recent_failures()` because **no pg_cron job calls it** — grep of `cron.job.command` for both the function name and `trust` returned zero. Its caller is therefore HTTP/external (edge fn / API route / cron-job.org), so its failures will surface only as **trust-board precompute staleness** or a `pipeline_runs` error/silence, NOT in the pg_cron failure check. Apply the SAME fix (RESET the attached clause; set `search_path` inside the body if the hardening must be kept). Whoever fixes it should first find the caller (it's not in pg_cron) and confirm the precompute has or hasn't already gone stale.

(The `/api/ready` `readiness_collection_stats()` and the two saved-wallet-stats objects R14 altered as regular FUNCTIONS are unaffected — only COMMIT-doing *procedures* are hit by the attached-`SET` rule.)

⚠ Whatever restores it, re-run `check_secdef_anon_exec_drift()` after (per CLAUDE.md) and confirm `prosecdef` stays `false`.

## Not findings (context, so the night pass doesn't re-chase)

- The other ~17 pg_cron failures this window are all `statement timeout` / `job startup timeout` — the known saturation-collateral + `max_worker_processes` startup-timeout classes from the 00:00–02:30Z heavy band (focus.md STEER 2026-08-22). Not N distinct bugs.
- `rpc-ccm-step2` timing out = the known cross-collection-mats-stale-since-08-18 item, already queued for night 3.
- Security clean (secdef-anon 0, anon-write-surface 0, invariants 0 rows, no RLS-off tables, no anon write grants). Latest Vercel prod deploy READY. Sentry 0 new/24h (but ingestion dark since 08-18 — already filed).
