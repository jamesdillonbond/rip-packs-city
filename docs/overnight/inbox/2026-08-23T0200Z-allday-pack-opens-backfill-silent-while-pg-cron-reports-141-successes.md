# `allday-pack-opens-backfill` is silent while pg_cron reports 141/144 successes

**Filed 2026-08-22 ~19:00 PT (2026-08-23 ~02:00Z), Claude Code interactive.**
Found incidentally while building a post-rotation silence detector for
`docs/runbooks/rotate-ingest-and-cron-secrets.md` — this was the detector's positive control,
and it turned out to be a live finding rather than a test fixture.

**Severity: medium.** Not user-facing. But it is green at every layer that reports, which is the
platform's most productive defect class.

---

## Established (measured, not inferred)

**pg_cron is firing the job and calling it a success.** `cron.job_run_details`, jobid 55
(`rpc-allday-pack-opens-backfill`, schedule `6,16,26,36,46,56 * * * *`), last 24h:

| status | n | last |
|---|---|---|
| `succeeded` | 141 | 2026-08-23 01:46:00Z |
| `failed` (`job startup timeout`) | 3 | 2026-08-22 15:06:00Z |

`succeeded` here means the `net.http_get` was **dispatched**. It says nothing about the callee.

**The pipeline has written nothing for 12.6 hours.** `pipeline_runs` for
`allday-pack-opens-backfill`: last row **2026-08-22 13:16:06Z**.

**And the silence is the tail of a much longer decline, not a fresh break.** Over the full ~72h
retention window it wrote **37 rows against a 10-minute schedule (~432 expected) — 8.6%** — of
which only **7 were `ok`**. Sample error: `events 84704748-84704997 status 0`.

⚠ **Do not read this as "it broke 12.6h ago."** It has been writing <10% of its expected rows
for at least three days; total silence is where that trend arrived.

**It is NOT an auth or gate-key failure.** `net._http_response`, last 24h: **771 × 200**,
**11 × 504**, **~236 with `status_code = NULL`** — and **zero 401s anywhere**. So this is not the
`_OLD` gate-key problem recorded in memory for jobs 20/55/56/83/84/44, and rotating that key
would not fix it.

**The NULL-status responses are DNS hangs, not application errors.** Every one has
`timed_out = true`, and several report *DNS time equal to total time*:

```
Timeout of 55000 ms reached. Total time: 55000.800 ms
  (DNS time: 55000.800 ms, TCP/SSL handshake time: 0.000 ms)
```

The request never resolved a hostname, let alone reached the function.

---

## NOT established — read these as open questions, not findings

- ⚠ **Which pg_net rows belong to job 55.** `net.http_request_queue` is pruned once a response
  lands, so the `r.id = q.id` join returns **zero rows** and after-the-fact URL attribution is
  impossible. The DNS-hang population is real; **its overlap with this job is unmeasured.**
  Attributing it by time-window overlap would be the mistake `attribute-by-set-membership-not-window-overlap`
  already records — do not do it.
- **Whether the edge function fails, times out, or succeeds without logging.** All three produce
  exactly this signature from outside.
- **Whether job 55 is the sole writer of this pipeline name.** The names correspond, but that was
  not verified against the function body.

---

## Suggested next step (cheap, and it settles the main fork)

Invoke the edge function **once, by hand**, and watch whether a `pipeline_runs` row appears:

- a row appears → the callee is fine and the problem is in dispatch (DNS / pg_net);
- no row and an error → the callee is broken; read the error;
- no row and a 200 → the callee succeeds and never logs, which is the worst branch and makes
  `pipeline_runs` unusable for this lane.

⛔ **Do not read the job's `command` to get the URL** — it echoes the live gate key
(`cron-job-command-echoes-gate-key`). Get the function name from
`supabase/functions/`, and the key from the operator.

---

## Related

- `docs/runbooks/rotate-ingest-and-cron-secrets.md` §5 — the detector that surfaced this, and the
  two wrong versions before it.
- Memory: `green-pipeline-blind-to-its-own-work`, `a-tick-that-never-started-writes-no-row`,
  `rows-written-zero-is-a-null-instrument`, `pgnet-http-response-is-the-edge-fn-instrument`.
- ⚠ Also currently silent and **not** flagged by the detector (its p90 gap is already huge):
  `topshot-active-listings-ingest`, 16.1h, error `egress_blocked` — the known open atlas-proxy
  item, not a new fault.
