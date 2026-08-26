# ⛔ The golazos "scheduler-skip" is REFUTED — the cron fired 8/8. ~22% of ALL `pg_net` dispatches time out, and 10% never resolve DNS — a STANDING rate, independent of saturation

- **When:** filed 2026-08-26 ~02:10Z (2026-08-25 19:10 PT) by Claude Code, interactive.
- **Supersedes the root-cause attribution in** [2026-08-25T1809Z-compute-golazos-pack-ev-cadence-silent-17h…](2026-08-25T1809Z-compute-golazos-pack-ev-cadence-silent-17h-pipeline-healthy-when-it-runs.md). That filing was right that the pipeline is healthy when it runs, and right to file the cause as unresolved. Its **mechanism was wrong**, and the correction generalises far beyond golazos.
- **Nothing shipped. Read-only. No DB write.** Measured in a genuinely quiet window (`io_wait=0, active=1, total=42`).

## 1. The scheduler did NOT skip — it fired every time

The earlier filing concluded *"a **scheduler-skip**, not a pipeline failure — the trigger simply is not firing on some ticks."* That is falsified by the dispatch record itself.

`compute-golazos-pack-ev` is **jobid 44**, a **pg_cron** job on `37 */6 * * *` issuing `net.http_get` to a Supabase edge function. ⚠ **Not a Vercel cron** — that closes step 3 of the earlier filing's suggested action, which asked which of the two it was. (⛔ Do **not** rotate this job's gate key: jobid 44 is on the known do-not-rotate list while `_OLD` dual-accept is deployed-only.)

`cron.job_run_details`, jobid 44, last 48 h: **8 ticks expected at `*/6`, 8 fired, 8 `succeeded`** — including all three the earlier filing listed as missing (08-24 18:37, 08-25 06:37, 08-25 12:37).

| tick (UTC) | cron fired? | `pipeline_runs` row? |
|---|---|---|
| 08-24 00:37 | ✓ succeeded | ✓ ok, 40→33 |
| 08-24 06:37 | ✓ succeeded | ✓ ok, 40→34 |
| 08-24 12:37 | ✓ succeeded | ✓ ok, 40→29 |
| 08-24 18:37 | ✓ succeeded | ⛔ **absent** |
| 08-25 00:37 | ✓ succeeded | ✓ ok, 40→36 |
| 08-25 06:37 | ✓ succeeded | ⛔ **absent** |
| 08-25 12:37 | ✓ succeeded | ⛔ **absent** |
| 08-25 18:37 | ✓ succeeded | ⛔ **absent** |
| 08-26 00:37 | ✓ succeeded | ✓ ok, 24→13 |

👉 **The dispatch always happens; the run row does not.** So the failure is **downstream of pg_cron and upstream of the edge function's own logging** — the request is issued and the function never gets to write. "cron_silent" was the wrong label: nothing about the *schedule* is silent.

## 2. The real mechanism, and it is platform-wide

`net._http_response` retains ~6 h. Over **2026-08-25 20:09Z → 2026-08-26 02:08Z**:

- **701 responses · 155 timed out · 22.1%**
- **70 of the 155 consumed their ENTIRE timeout inside DNS** — `Timeout of 90000 ms reached. Total time: 90002.632 ms (DNS time: 90002.632 ms)`, and the 55 s variant likewise. **DNS time == total time**, so the request never left the box and the target function **definitively never ran**.
- The other 85 show `DNS time: 0.039 ms` — resolution fine, the request itself hung.
- 535 × HTTP 200, 11 × 5xx.

⭐ **THE DEFENSIBLE FLOOR IS THE DNS SUBSET: 70 of 701 = 10.0% of all `pg_net` dispatches never resolved DNS.** The other 85 are ambiguous by design — several crons set a short `timeout_milliseconds` on a function that legitimately runs longer, and there the function still executes and writes its own row, so a pg_net "timeout" is expected and harmless. **Do not quote 22.1% as a failure rate; quote 10.0% and call the rest unclassified.**

## 3. ⛔ It is NOT saturation collateral — and that is the part worth keeping

The obvious reading is that this is the known disk-IO spell. **Measured against the spell, it is not.** `io_wait` was **19** at 20:52Z and **21** at 21:10Z (confirmed spell), and **0** at 02:07Z (quiet). The hourly timeout rate across that transition:

| hour (UTC) | responses | timed out | % | DNS-hang | state |
|---|---|---|---|---|---|
| 20:00 | 98 | 22 | **22.4%** | 8 | spell |
| 21:00 | 111 | 27 | **24.3%** | 16 | spell |
| 22:00 | 116 | 24 | 20.7% | 11 | |
| 23:00 | 118 | 26 | 22.0% | 12 | |
| 00:00 | 120 | 26 | 21.7% | 13 | |
| 01:00 | 118 | 26 | 22.0% | 8 | |
| 02:00 | 20 | 4 | **20.0%** | 2 | quiet |

**Range 20.0–24.3% across seven hours spanning a spell and a quiet window.** Flat. A saturation-driven rate would track `io_wait`; this does not. 👉 **This is a STANDING egress failure, not a symptom of the characterized IO root cause** — which means PRIORITY 3's bar on re-opening saturation does **not** apply to it.

## 4. ⚠ What this does NOT establish

- ⛔ **`net._http_response` does not store the URL** (columns are `id, status_code, content_type, headers, content, timed_out, error_msg, created`). So **no timeout here can be attributed to golazos, or to any named pipeline.** The link is circumstantial and stated as such: the cron fired, no run row exists, and ~1 in 10 dispatches provably never resolved in the same window.
- ⚠ **One ~6 h overnight window.** Retention gives no more. A rate this stable across seven hours is suggestive, but it is **one sample, not a distribution** — daytime may differ.
- ⚠ The `io_wait` figures are **three point-samples**, not a continuous series.

## 5. Suggested action — a DECISION, not a fix

1. ⭐ **Re-measure in a daytime window** and confirm the ~10% DNS floor holds. If it does, this is a standing platform defect worth raising with Supabase — `pg_net`'s resolver hanging for the full timeout is not a workload problem.
2. **The cheap durable fix is attribution, not repair:** nothing today can map a `pg_net` failure to the pipeline that issued it. Recording the `request_id` returned by `net.http_get` alongside the job would make every future occurrence attributable in one join. That is a small additive change and it is what turns this from circumstantial into measured.
3. ⚠ **Re-read every `cron_silent` conclusion on a `net.http_get` pipeline.** If ~10% of dispatches never land, then "silent" arms across the platform have been carrying a baseline of false positives that look exactly like a stopped scheduler — the golazos filing is one instance, and it will not be the only one.
4. Golazos itself remains **NOT urgent**: the board is fresh and the market is thin.
