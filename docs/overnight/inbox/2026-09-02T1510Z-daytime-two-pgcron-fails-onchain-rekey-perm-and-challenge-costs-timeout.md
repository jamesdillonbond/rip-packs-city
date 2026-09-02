# Daytime candidate — two pg_cron failures (2026-09-02 ~08:10 PT / 15:10Z tick)

Filed by `rpc-daytime-monitor`. Read-only sweep, first-tick-of-day. Positive control clean
(io_wait 0 / active 0 — NOT a saturation spell), so the reads below are interpretable.
Both items are LOW priority and each looks self-clearing; filed so the night pass can confirm
on the next tick rather than re-discover.

## 1. `rpc-topshot-onchain-rekey` (jobid 434) — permission denied at 11:33Z, but the grant is present NOW → verify next tick, do not "fix"
- **Source:** `check_pgcron_recent_failures()` — latest run 2026-09-02 11:33:00Z `failed`,
  `ERROR: permission denied for function run_topshot_onchain_rekey`. Job runs as `cron_heavy`,
  schedule `33 11 * * *` (daily). Only one run present in the 3-day `job_run_details` window.
- **Why it is almost certainly already fixed:** re-checked the catalog at ~15:1xZ —
  `run_topshot_onchain_rekey` is `SECURITY DEFINER`, owner `postgres`, and
  `has_function_privilege('cron_heavy', …, 'EXECUTE')` = **true** right now. The 11:33Z error is the
  OUTER-function EXECUTE check (a SECDEF body runs internal calls as its owner, so the denial can only
  be on the entry call by `cron_heavy`). Since `cron_heavy` now HAS execute, the failure predates the
  grant landing and per the pg_cron rule is a STALE pre-fix run.
- **Risk read:** none to touch — the config is now correct. Only risk is a false "fix" that re-grants
  what already exists.
- **Suggested action (night pass / next tick):** confirm the **next** run (2026-09-03 11:33Z) succeeds.
  If it fails AGAIN with the same error, THEN the grant is being reset between runs (investigate what
  redefines the function or re-creates the job as `cron_heavy` without the grant — the
  CREATE-OR-REPLACE-resets-grants class). No action unless it recurs.

## 2. `rpc-refresh-challenge-costs` (daily, postgres) — one statement-timeout at 07:20Z after two clean days → saturation-collateral symptom, re-measure
- **Source:** `check_pgcron_recent_failures()` — latest run 2026-09-02 07:20:00Z `failed`,
  `ERROR: canceling statement due to statement timeout` in the `UPDATE public.challenges SET
  cached_reward_value = …`. Schedule `20 7 * * *`; 2026-09-01 and 2026-08-31 both `succeeded`.
- **Risk read / classification:** SYMPTOM, not a cause. `refresh_challenge_costs` is a known ~91s
  daily batch (known-issues #52) that reads the `pack_ev_latest` / `fmv_current` DISTINCT-ON views; a
  single timeout after two successes on a once-a-day job is most likely a disk-IO saturation spell
  during its 07:20Z window (focus.md STEER #3: fmv-recalc kills, `public_board_slow_count`, pg_cron
  statement-timeouts are ONE root cause — the SMALL-tier IO budget; the lever is cutting work, never
  raising the timeout or upgrading the tier). Per spell-time discipline this is filed as a symptom,
  not a cost/cause claim.
- **Suggested action (night pass):** re-measure at the next 07:20Z tick. If it times out again, the
  batch has crossed its budget and the lever is scoping the `UPDATE`'s per-view reads (the same
  DISTINCT-ON-filtered-on-non-key-column shape already fixed elsewhere — ledger `pack_ev_latest`
  work), NOT the timeout. If it clears, close as a transient spell.

---
**Sweep result:** otherwise GREEN. Security invariants all `[]`; stalled_pipelines `[]`; sentinel
ts_uuid 48h = 0; trust health = the two KNOWN structural breaches only (`public_board_slow_count`=1,
`unmapped_resolution_backlog_max`=209, declining 225→209); cross-collection refresh fresh + both steps
succeeded; latest Vercel prod deploy READY. **Sentry connector was invalidated this run (unavailable)** —
consistent with the standing #34 Sentry-dark note; client-only errors remain uncaptured. **Artifact HTML
lives outside the mounted folder (C:\Users\TDill\Claude\Artifacts), so per-payload validation was
skipped this run;** the backing data queries that the live-health dashboard reads
(`rpc_ops_snapshot`, `v_rpc_trust_health`, cross-collection mats) all succeeded.

*inbox written to mount, push unavailable (cloud NO-PUSH — mount `remote.origin.pushurl` is the
unauthenticated public URL).*
