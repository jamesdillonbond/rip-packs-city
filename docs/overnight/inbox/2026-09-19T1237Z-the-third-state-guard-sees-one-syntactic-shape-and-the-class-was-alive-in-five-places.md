# The unhandled-third-state guard sees ONE syntactic shape, and the class was alive in five places it cannot see — plus a weekly pricing lane with no telemetry at all

*Claude Code, Trevor's Windows box, filed 2026-09-19 ~5:4x AM PT (12:37Z). **Repo-only; five sites already FIXED and pushed. Nothing applied to the DB** — the estate was bouncing (io_wait 19/16 at 05:19 PT, easing to 9/7 by 05:30) and a concurrent session was applying its own migrations throughout.*

## §1 — What the shipped guard can actually see

`scripts/check-unhandled-third-state.mjs` is a good guard: ban at zero, tree walk, built-in positive **and** negative control, asserts the file count it inspected. It reports `1361 file(s) inspected, 0 violations` and that is true.

⛔ **But it bans ONE SYNTACTIC SHAPE, not the class its own header describes.** Both of its regexes require a **bare identifier**:

```js
const HEAD = /if\s*\(\s*!?([A-Za-z_$][\w$]*)\s*\)\s*\{/g          // `if (error) {`
const ELIF = /^\}\s*else\s+if\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/ // `} else if (data) {`
```

…and the head's identifier must literally contain `error` (or be `err`). So **every one of these is invisible to it**:

| form | why invisible |
|---|---|
| `if (res.error)` | member expression, not a bare identifier |
| `else if (data && typeof data === "object")` | compound condition |
| `else if (typeof res.data === "number")` | compound condition |
| `else if (rows && rows.length > 0)` | compound condition |
| `if (!error && Array.isArray(data)) … else if (error)` | error-ish test is in the **else-if**, i.e. the shape is inverted |

⭐ **This is CLAUDE.md's own rule turned on the guard: "a guard's ROOT *and stated CLASS* are CLAIMS."** The header claims the honesty canon's three-states property; the code delivers a single spelling of it.

## §2 — Measured: 8 matches on a broadened scan, 5 real, 3 correctly not the class

Broadened detector (same roots, same `scripts/lib/strip-comments.mjs` — not a fresh copy), 1,368 files:

**broad two-branch matches: 8 · INVISIBLE to the shipped guard: 8** (i.e. the shipped guard saw **none** of them).

Triaged one by one, because a match is a hypothesis:

| site | verdict |
|---|---|
| `app/api/cron/refresh-serial-fmv-multipliers/route.ts:36` | ⛔ **REAL.** `compute_serial_fmv_multipliers` is `RETURNS integer`; a plpgsql NULL comes back with **no error**, and `typeof null === "object"`, so the numeric branch is skipped, `ok` stays **true** and `rows` stays **0** — and `log_pipeline_run` publishes that pair as a measurement. CLAUDE.md's *"`rows_written = 0` is a null instrument"*, exactly. |
| `app/api/best-offers/route.ts:195` | ⛔ **REAL, public API.** No error + non-array payload dropped the serial-grain offers silently, publishing a **lower best offer** as the real one. |
| `app/api/cron/run-insider-detectors/route.ts:170` | ⛔ **REAL.** That collection contributed nothing to `result` **and** nothing to `failed`, so the run reported `ok = true` with the collection simply absent — absence reading as "no problems here". |
| `lib/admin/error-triage.ts:100` | ⛔ **REAL.** Non-array payload left `summary` empty with no error — a clean bill of health on an **error dashboard**. |
| `app/api/cache-refresh/route.ts:362` | ⛔ **REAL (minor).** A successful update returning no `count` added nothing, so `last_seen_touched` under-reported while reading as exact. |
| `app/api/profile/collection-stats/route.ts:104` | ✅ **FALSE POSITIVE, and worth recording.** The missing `else` is deliberate: the cache read is best-effort and **falls through to a live RPC** that classifies `57014` and uses `safeApiError`. The file says so. |
| `lib/logger.ts:28` | ✅ Not the class — `err` is a caught exception, not a read result. |
| `lib/allow-list/prewarm.ts:694` | ✅ Not the class — matched only on the word "failed". |

**All five REAL sites are fixed and pushed** (each gets an `else` that says what happened; the numeric-zero path is untouched, because a real 0 IS a measurement). Re-running the broadened scan: **8 → 3**, and the 3 are exactly the triaged non-instances.

## §3 — 👉 THE OPEN ITEM: broadening the guard is not a one-line change, and here is the trap

A naive broadening (accept any condition, match the word `error` anywhere) **flags `lib/logger.ts` and `lib/allow-list/prewarm.ts`, which are correct code.** A ban-at-zero guard that reds on correct code gets an allowlist bolted on, and CLAUDE.md prefers the opposite.

⭐ **The principled scope is the RESULT SHAPE, not the word:** the branch pair must be reading a **supabase/PostgREST result** — a destructured `{ data, error }` or a `<x>.error` whose `<x>` came from `.rpc(`/`.from(`. That excludes both false positives by construction rather than by allowlist. **Not attempted here** — it needs light scope tracking, and shipping a half-broadened ban-at-zero guard is worse than the narrow one.

⚠ **Whoever takes it: the population is ZERO right now** (the five are fixed), so the broadened guard must be satisfiable at zero and must carry its own positive control for each newly-covered form — the shipped guard's control only exercises the bare-identifier shape, which is precisely why the gap survived.

## §4 — 🚨 A SEPARATE, BIGGER FINDING FOUND ON THE WAY: the serial-FMV-multiplier lane has NO telemetry

Chasing whether the `refresh-serial-fmv-multipliers` third state had ever actually fired produced this instead.

- `pipeline_runs` for that pipeline: **0 rows** — but retention is ~73 h, so an absence there is a **retention artifact**, not evidence.
- `pipeline_runs_daily` (**indefinite**) for `pipeline ilike '%multiplier%'`: **0 rows, ever.**
- `cron.job`: **two ACTIVE weekly jobs** — jobid **5** `rpc-serial-fmv-multipliers-weekly` (`0 11 * * 0`) and jobid **49** `rpc-allday-serial-fmv-multipliers` (`15 11 * * 0`).
- ⭐ **Classified without echoing the command text** (it can carry gate keys): both are `calls_the_rpc_directly = true`, `uses_pg_net = false`, `calls_the_next_route = false`, **`logs_pipeline_run = false`**.
- The Next route `/api/cron/refresh-serial-fmv-multipliers` is referenced by **nothing but its own two test files** — no `vercel.json` cron, no GitHub Actions workflow, no pg_cron, no in-repo fetch.

⇒ **Two independent instruments agree** (the rollup is empty *and* the commands provably do not call `log_pipeline_run`), so this is not a bare absence claim:

1. **The work runs weekly in pg_cron and writes NO `pipeline_runs` row at all.** So this lane is invisible to `detect_stalled_pipelines()`, to the fleet alarm, and to every instrument that reads `pipeline_runs`. It is register **#79**'s "ran, succeeded, found NOTHING" state — except here it is "ran, and nothing anywhere knows".
2. **The Next route is DEAD** — zero callers — while carrying two test files that make it look live and covered. Its third-state bug was therefore harmless today; it is fixed anyway, because a dead route is a route someone will wire up.

👉 **Not actioned here, deliberately:** giving the lane telemetry means rewriting two `cron.job` commands, which is a DB write, and the instance was bouncing with a concurrent session mid-migration. **Decide first whether the fix is (a) add a `log_pipeline_run` leg to both commands, or (b) point the schedules at the existing Next route and delete the duplication.** (b) is tidier and makes the tests load-bearing; (a) is smaller and avoids adding an HTTP hop to a pricing lane. ⚠ **Either way, confirm first that the weekly jobs are actually SUCCEEDING** — `cron.job_run_details` for jobids 5 and 49, read bounded, in a quiet window. Nothing in this filing establishes that they work, only that they are scheduled and silent.
