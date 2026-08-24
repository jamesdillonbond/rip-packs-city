# The recurring `pg_net_http_403` CRITICAL is ONE job — jobid 16 — and it is one of the three D2b calls "rotated + verified"

> 🔴 **CORRECTION, same session ~09:00 PT — THIS ATTRIBUTION IS NOT NEW.**
> [`2026-08-12T1354Z-jobid16-403s-and-a-newly-critical-arm.md`](2026-08-12T1354Z-jobid16-403s-and-a-newly-critical-arm.md)
> reached the same conclusion a day earlier, by the SAME minute-fingerprinting method. I did not
> read the inbox before investigating, so the framing below — "the attribution the monitor said was
> impossible" — overclaims: the monitor could not do it, but a prior Claude Code session already had.
> The register's own standing warning is exactly this: *re-probe before acting; concurrent sessions
> ship to this repo constantly.* Left in place rather than rewritten, so the duplication stays visible.
>
> **What this file still adds, each checked independently:**
> 1. The 08-12 filing called the onset "unprovable directly" because `net._http_response` retains only
>    ~1.6h. The `gql_historical` staleness of **35.9h** dates it to ~2026-08-12 03:33Z from a second,
>    independent instrument — and **agrees** with the 03:33Z burst they inferred.
> 2. The **key-digest comparison**: jobs 20/55 carry an identical digest and 20 is healthy, which rules
>    out the AllDay pair; 15/16 share one key, so fixing one fixes both.
> 3. That jobid 16 is one of the **three functions D2b records as ✅ rotated + verified** — so the
>    rotation has REGRESSED. Neither the 08-12 file nor the runbook makes that point, and it is the
>    reason a D2b progress audit would wrongly read 15/16 as done.
> 4. The jobid-55 addendum at the foot of this file.
>
> ⚠ Their impact finding is also sharper than mine on one point and should be preferred:
> **`backfill-topshot-pack-supply` never calls `logPipelineRun` at all**, so its absence from
> `pipeline_runs` is BY DESIGN and is not evidence of anything. My "do not read `pipeline_runs` for
> confirmation" note below reaches the right conclusion for a weaker reason.

Claude Code, interactive, 2026-08-13 ~08:30 PT. **Read-only investigation; nothing changed.**
Operator action required (secrets) — see the bottom.

## The attribution the monitor said was impossible

The 08-13 daytime monitor filed `pg_net_http_403` CRITICAL (24 per 2h) and stated:

> "Can't attribute exact jobs (`net._http_response` won't join to URL)."

That is true as stated — `net.http_request_queue` is pruned on completion, so the response
row genuinely cannot be joined back to the URL it came from. **But the FIRING MINUTE is a
fingerprint, and pg_cron schedules are distinct enough to be identifying.**

```sql
select extract(minute from created)::int AS min_of_hour, count(*) n
from net._http_response where status_code = 403 group by 1 order by 1;
```

Result — 72 rows over the ~6h `net._http_response` retention window:

| minute | 3 | 8 | 13 | 18 | 23 | 28 | 33 | 38 | 43 | 48 | 53 | 58 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| count | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 | 6 |

That is **exactly and only** the schedule of **jobid 16 `rpc-backfill-pack-pool`**:

```
3,8,13,18,23,28,33,38,43,48,53,58 * * * *
```

12 firings/hour × 6 hours = 72. Perfectly uniform, **no other minute carries a single 403**.
So 100% of the 403s are one job, not "a different subset of the 14 gate-keyed jobs".

⚠ **DURABLE METHOD — minute-fingerprinting attributes a pg_net response to its cron job
without any join.** Applicable to any `net._http_response` triage. It works because pg_cron
minute-lists are near-unique across the estate; verify the candidate is unique before
concluding (here, no other gate-keyed job fires on a 5-minute offset-3 pattern).

## Why this matters more than a normal 403

**Jobid 16 is one of the THREE functions D2b records as already done:**

> ✅ Rotated + verified: `backfill-pack-opens-api`, `backfill-allday-pack-supply`,
> **`backfill-topshot-pack-supply` (cron 15+16 repointed)**

The 08-10 handoff says v25 was deployed, `mode=debugpool` probed **200 OK**, and cron 15+16
were repointed to the new key. It is now 403ing **100% of ticks**. So the rotation of
`backfill-topshot-pack-supply` has **REGRESSED since 2026-08-10** — the secret and the
deployed function no longer agree with the `?key=` in cron.

This also means the monitor's framing — "the 08-11 real-loss ingest jobs are healthy now, so a
*different* subset re-403'd" — is right that it is a different job, but the important part is
that **it is a job the runbook considers finished.** Anything auditing D2b progress by reading
the handoff will conclude 15/16 are done. They are not.

## What is NOT the cause (checked, so nobody re-derives it)

- **Jobs 15 and 16 share one key** (identical md5 digest, both length 25). Job 15 runs
  `15 8 * * *` — once daily, outside the retention window — so it is unobserved here but is
  almost certainly 403ing too. **Fixing one fixes both.**
- **It is NOT the AllDay pack-opens pair.** Jobs 20 and 55 carry an **identical key digest**
  (`d971b592…`, length 27) and job 20 is **100% healthy** (46/48 runs in 24h), which proves
  that key is valid for `ingest-allday-pack-opens`. Separately, jobs 56, 83 and 84 are all
  delivering their full expected tick counts (8/8, 12/12, 60/60 per 2h).
- ⚠ **Keys were compared by md5 digest only, never echoed** — the technique the 08-12 inbox
  note recommends after `get_edge_function` was found to return live gate keys in plaintext.

## Impact — bounded, and smaller than it looks

`pack_drop_pool` for Top Shot, by source:

| pool_source | rows | newest | stale |
|---|---|---|---|
| `gql` | 26,322 | 2026-08-13 15:25:33Z | **0.0h** |
| `gql_historical` | 9,316 | 2026-08-12 03:33:08Z | **35.9h** |
| `atlas` | 25,594 | 2026-07-17 14:18:10Z | 649.1h (separate, known) |

The **live pool is fresh** — `compute-topshot-pack-ev` is healthy (1,383 runs in the retention
window, last 15:25:09Z) and refreshes the `gql` rows. So pack EV is NOT broken. What has
stopped is the `gql_historical` leg, stale **35.9h**, which dates the onset to roughly
**2026-08-12 03:33Z** — i.e. this began well after the 08-10 rotation was verified.

⚠ Do **not** read `pipeline_runs` for confirmation: `backfill-topshot-pack-supply` has **no
rows under any name** in the full 73h window, and that is exactly the D2 signature — a 403'd
edge function writes NO `pipeline_runs` row, so silence is indistinguishable from "never
scheduled". The 403 rows are the positive evidence; the absence is not.

## Operator action

Realign `TOPSHOT_PACK_SUPPLY_GATE_KEY` with what cron 15/16 send. Either:

1. Set the secret to the value cron currently sends (fastest — restores service now), or
2. Fold jobs 15/16 into the single atomic rotation window the runbook already specifies
   (set the 8 `*_GATE_KEY` secrets → deploy the env-var functions → repoint every pg_cron
   `?key=` together).

Option 2 is preferable because **the partial-rotation state is what produced both this and the
08-11 outage**, and four other functions are still un-rotated. Full mechanics:
[docs/handoff-2026-08-10-gate-key-rotation-progress.md](../../archive/handoffs/handoff-2026-08-10-gate-key-rotation-progress.md).

**Re-probe after fixing** — the check is one query, and it should return zero rows:

```sql
select count(*) from net._http_response where status_code = 403;
```

---

## Addendum — jobid 55 measured further; two theories KILLED, cause still open

Same session, ~08:45 PT. The body above filed jobid 55 (`rpc-allday-pack-opens-backfill`,
~92% tick loss) as characterised-but-unexplained. Four more measurements, three of which
close off a lane so the next investigator does not spend time there:

1. **Dispatch is fine.** `cron.job_run_details` for jobid 55 over 24h: **143 succeeded, 1
   failed** (that one `job startup timeout`). So pg_cron is firing ~144/144 as scheduled,
   while `pipeline_runs` holds only **11** rows. ~132 dispatches produced no row.
2. **NOT a 403.** Job 55 fires on minutes 6/16/26/36/46/56, and by the minute-fingerprint
   above those minutes carry **zero** 403s — all 72 belong to jobid 16.
3. **NOT the exception path.** ⚠ I first read the `catch` as returning HTTP 200 without
   logging and called that decisive. **That was wrong** — the catch DOES
   `await logRun(..., ok:false, ...)` before returning. Corrected here so the mistake is not
   inherited.
4. **NOT simply pg_net timeouts.** The 215 NULL-status (timed-out) `net._http_response` rows
   are ~6 per minute-slot fairly uniformly; minutes 6/16/26/36/46/56 read 11–13, but those
   slots host **two** jobs (55 and 83), so per-job the rate is ordinary. Decisively: **jobid
   83 shares those exact minutes and delivers 12/12 expected runs per 2h** while 55 delivers
   1. Whatever it is, it is not the minute slot.

### What WAS found, and fixed in the same session

`ingest-allday-pack-opens` had one genuinely silent path: `const t = await tip(); if (!t)
return … status 200` sits **outside** the `try`, so an unreachable tip produced **HTTP 200 +
no `pipeline_runs` row + cron "succeeded"** — clean on every instrument while the walk did
nothing. Now logs `ok:false` / `tip_unreachable`. ⚠ **This is NOT established as job 55's
cause** — `tip()` is shared with mode=forward (jobid 20), which is healthy at 46/48, so a tip
outage would have to be implausibly mode-correlated. It is fixed because it is a real
instance of the invisible-failure class, not because it explains this.

⚠ **NOT DEPLOYED** — `ingest-allday-pack-opens` is jobid 20/55, two of D2b's five un-rotated
functions. Deploying the repo copy without `ALLDAY_PACK_OPENS_GATE_KEY` set would 403 both
modes. It rides the rotation window with the `compute-pinnacle-pack-ev` fix.

**Next probe for whoever picks this up:** once deployed, the new `tip_unreachable` rows will
either appear (cause found) or not (cause elsewhere — then instrument the walk body, since
the remaining candidates are an early return inside `mode=backfill` or the 90s pg_net timeout
killing a long spork walk before its terminal `logRun`).
