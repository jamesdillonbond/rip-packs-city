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


---

# CONFIRMED ~13:55 PT (20:55Z), same day — **both items were already fixed hours before this filing was written.** Item 2's classification is wrong.

Neither needs the next tick. Checked by the cloud session that shipped both fixes.

## 1. `rpc-topshot-onchain-rekey` — ✅ RESOLVED, and now INSTRUMENTED

The filing's reasoning is right and the conclusion holds. Two things to add:

- **Timing.** The grant migration is named `20260902113501` (11:35:01Z); the failed run was
  **11:33:00Z** — the grant landed about two minutes later. ⚠ **That is corroboration, not proof:**
  `supabase_migrations.schema_migrations` has columns `version, statements, name, created_by,
  idempotency_key, rollback` and **no applied-at timestamp**, so the filename is the only clock. Do
  not quote it as an apply instant.
- ⭐ **The better evidence is an instrument, not a timestamp.**
  `check_cron_heavy_job_exec_drift()` → **`{"inspected": 56, "offenders": []}`**. That function was
  shipped the same morning *for exactly the recurrence this filing asks the night pass to watch for*
  (the CREATE-OR-REPLACE-resets-grants class), it walks every `cron_heavy`-scheduled callable rather
  than the one that failed, and it is wired into `/api/smoke-test` as a **hard** arm that fails closed
  on `inspected < 20`. So "confirm the next run" is no longer the only check available: **a reset
  would now red the smoke suite within the hour instead of surfacing as one failed job a day later.**
- ⛔ Agreed: **do not re-grant.** Confirmed correct.

## 2. `rpc-refresh-challenge-costs` — ⚠ THE CLASSIFICATION IS WRONG, and the fix shipped 4 h 40 m after the failure

**"A single statement-timeout at 07:20Z after two clean days" understates it.** Full
`cron.job_run_details` for jobid 87, eleven consecutive daily runs:

| date | result | duration |
|---|---|---:|
| 08-23 | **failed** | 120 s (timeout) |
| 08-24 | **failed** | 120 s (timeout) |
| 08-25 | succeeded | 57.5 s |
| 08-26 | **failed** | 120 s (timeout) |
| 08-27 | succeeded | 74.3 s |
| 08-28 | succeeded | 81.3 s |
| 08-29 | succeeded | 101.6 s |
| 08-30 | succeeded | 82.7 s |
| 08-31 | succeeded | 40.1 s |
| 09-01 | succeeded | 40.5 s |
| 09-02 | **failed** | 120 s (timeout) |

👉 **Four failures in eleven runs — 36%, not one.** ⚠ **The filing looked back two days and inferred a
transient spell from it. A rate needs a DISTRIBUTION, not a snapshot** — this repo's own rule, and the
two days it happened to sample (40.1 s and 40.5 s) were the two fastest runs in the window. The
successes trend 57 → 74 → 81 → **101** → 82 against a 120 s ceiling: a batch chronically at its
budget, which is a cost problem, not collateral.

**And it is already fixed.** Migration `20260902120329` hoists arm 1 of the `cached_reward_value`
COALESCE out of the per-row loop into a `_pack_ev` temp table — verified live in `pg_proc`
(`refresh_challenge_costs` now contains `CREATE TEMP TABLE _pack_ev`) — and the hoisted function
**measured 1.208 s** against that 40–101 s history. The 07:20Z failure this filing reports predates
that migration by **4 h 40 m**; every run in the table above is pre-fix.

⭐ **Credit where due: the filing named the correct lever without knowing it had landed** — *"scoping
the UPDATE's per-view reads (the same DISTINCT-ON-filtered-on-non-key-column shape already fixed
elsewhere)"*. That is precisely the fix. Only the priority ("LOW", "self-clearing") and the
saturation-collateral read were wrong.

**Expected at the next tick (2026-09-03 07:20Z): a success in ~1–2 s.** If it instead times out
again, the hoist is not the whole cost and arms 2–4 need the same treatment — that, not a timeout
bump, remains the lever.

## 3. ⭐ That DISTINCT-ON shape is now THREE instances, and it is a root cause, not a coincidence

`pack_ev_latest` (challenge costs), and — found independently the same day — `fmv_current` in
`/api/sniper-feed`'s All Day leg, where a qual on `collection_id` against a view keyed on
`edition_id` materialised **274,519 rows per page, 19.5 s, six pages**, producing paired
`statement timeout` + `Task timed out after 45 seconds` errors on one request. **A qual on a
DISTINCT ON view's KEY pushes down; a qual on any other column does not.** Written up in
[database.md](../../reference/database.md).
