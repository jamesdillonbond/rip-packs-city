# The pg_cron startup timeout is NOT a worker-slot cap — it is the saturation, and the obvious config fix does nothing

Filed 2026-08-16 21:10 PT / 2026-08-17 04:10Z (Claude Code, interactive), while working the 8-alert sentinel digest.

**Read the "REFUTED" section before touching any Postgres setting.** The tidy explanation for this
alert is wrong, and it is wrong in a way that would send someone to change `max_worker_processes`
or `cron.max_running_jobs` for zero effect.

---

## The alert

```
🟠 pgcron-startup-timeout — 26 pg_cron tick(s) failed with "job startup timeout"
   in the last 30 min across 14 job(s)
```

The arm is doing its job and is well-built: the function body never runs, so nothing lands in
`pipeline_runs`, and both `detect_stalled_pipelines()` and the `cron_silent` arm are structurally
blind to it. That is exactly why it exists.

## ⚠ REFUTED — the worker-slot hypothesis, and how the data killed it

The seductive reading, which I published mid-session before checking it:

| setting | value |
|---|---|
| `cron.max_running_jobs` | **32** |
| `max_worker_processes` | **6** |

A 5× oversubscription. pg_cron *can* run jobs as background workers, those come from
`max_worker_processes`, and the first evidence fit: failures arrive in contiguous bands
(03:38–03:50Z), not at high-start-count minutes, and during that band exactly **six** multi-minute
jobs overlapped. Six jobs, six slots. It looked settled.

**It is wrong.** Two measurements killed it:

1. **The concurrency histogram has occupied states above the supposed cap.** Timeout rate by number
   of concurrently-running jobs at the moment of the attempt (6 h window):

   | concurrent | attempts | timeouts | rate |
   |---|---|---|---|
   | 1 | 244 | 0 | 0.0% |
   | 2 | 258 | 11 | 4.3% |
   | 3 | 233 | 5 | 2.1% |
   | 4 | 152 | 8 | 5.3% |
   | 5 | 76 | 5 | 6.6% |
   | 6 | 30 | 5 | 16.7% |
   | **7** | 9 | **0** | 0.0% |
   | **8** | 3 | **0** | 0.0% |
   | **9** | 1 | **0** | 0.0% |

   If 6 worker slots were a hard cap, **concurrency 7, 8 and 9 could not exist** — and they do,
   cleanly, with zero timeouts. A cap that is exceeded is not a cap.

2. **`cron.use_background_workers = off`** (verified live; it is the pg_cron default). So this
   instance's pg_cron does **not** use background workers at all. It opens **libpq connections to
   `localhost`** and runs each job as an ordinary client backend against `max_connections = 90`
   (currently ~47 in use — nowhere near exhausted).

`max_worker_processes` is therefore irrelevant to this alert, and `cron.max_running_jobs = 32` is
not being reached either.

## What it actually is

**"Job startup timeout" is pg_cron failing to complete a connection handshake within its internal
budget.** Under disk-IO saturation, forking a backend plus auth plus startup stops fitting, and
pg_cron abandons the tick. That reframes the alert completely:

> It is not an independent configuration defect. It is a **second symptom of the same
> platform-wide disk-IO saturation** that produces the `statement timeout` / `upstream request
> timeout` / `Timed out acquiring connection from connection pool` errors on the rest of the board.

The concurrency correlation is real but it is a **load** correlation, not a slot cap: more
concurrent jobs → more saturation → slower connection startup. Averages, same window:
**3.65** concurrent at timeout attempts vs **2.68** at successful ones.

⚠ **Consequence for triage: do not open this as its own investigation.** It rises and falls with
the saturation. It is chronic, not new — daily rate over 10 days: 0.50%, 1.05%, 0.55%, 1.58%,
2.06%, 0.94%, 1.07%, 3.85%, 3.07%, 1.65%, and 5.01% so far today. Elevated today, present all month.

## The one concrete, actionable lever

Jobs that run to the **600 s `cron_heavy` role budget, fail, and roll back** are pure waste: they
hold a connection for ten minutes, burn IO the whole time, and produce nothing — while making
connection startup slower for everything else.

**44 runs across 17 distinct jobs died at ~600 s in the last 2 days** (~7.3 hours of connection
time producing zero). Worst offenders:

| job | runs | died at ~600 s | avg s |
|---|---|---|---|
| `rpc-allday-nem-from-sales-backfill` | 93 | **9** | 323 |
| `rpc-backfill-historical-pack-ev` | 48 | **6** | 216 |
| `rpc-refresh-allday-pack-realized` | 8 | **5** | 435 |
| `rpc-atlas-pack-ev` | 48 | **4** | 192 |
| `rpc-refresh-mv-pack-ev-latest` | 95 | **4** | 106 |

`rpc-refresh-allday-pack-realized` is the sharpest: **5 of its 8 runs** die at the ceiling.

⚠ **This is the same shape as the trust-precompute monolith** already documented in CLAUDE.md —
work that cannot fit its budget, rolling back and starving its neighbours — and the same remedy
applies: **split or shrink the WORK, never raise the clock.** Raising the budget makes each failure
hold a connection *longer* on the instance whose saturation caused it.

## Where the IO is actually going

`pg_stat_statements`, ranked by `shared_blks_read` (cumulative since last reset — treat as a
ranking, not a rate):

| statement | calls | mean ms | blks read | hit % |
|---|---|---|---|---|
| `refresh_wmc_fmv_changed` | 496 | **302,207** | **38.9 M** (~304 GB) | 84.9 |
| PostgREST RPC (unidentified) | 866 | 13,174 | 26.4 M | 19.8 |
| `panini_squeeze_board` read | 3,267 | 3,658 | 25.4 M | 92.6 |
| `raise_impossible_parallel_circ` | 120 | 45,829 | 19.0 M | **6.3** |
| `backfill_wmc_fmv_confidence` | 2,088 | 21,418 | 17.8 M | 78.1 |

⚠ **`refresh_wmc_fmv_changed` is #1 by 1.5×, at 41.6 hours of cumulative execution time.**
CLAUDE.md documents it as **#2 at 112 GB / mean 330 s** and — correctly — as **NOT a defect**: the
cost is the UPDATE fan-out inherent to the `wmc.fmv_usd` denormalization, and *the lever is the
denormalization*. It has since grown to ~304 GB. **Do not "optimize" the function**; that was
already measured and the redundant re-lookup inside it prices at 0.24%.

`raise_impossible_parallel_circ` at a **6.3% buffer hit ratio** is the one genuinely
under-examined entry here — near-total disk, 45.8 s mean, 120 calls. Not investigated.

## What I did NOT do, and why

- **Did not change `cron.max_running_jobs` or `max_worker_processes`.** Both are refuted above as
  the mechanism, and both are Supabase-managed (the latter needs a restart).
- **Did not lower any cron cadence.** Which jobs deserve their IO share is a product decision, and
  CLAUDE.md records a prior stagger plan that was *refuted and harmful* when pasted rather than
  re-derived.
- **Did not suppress this alert.** It is correctly reporting a real condition. Suppressing the one
  arm that can see a class nothing else can see would be the wrong trade.

## The falsifier

If the saturation reading is right, the startup-timeout rate should track the platform's IO
pressure and **fall when the 600 s-death population falls** — it should not respond at all to a
`cron.max_running_jobs` change. If someone lowers that setting and the rate moves, this filing is
wrong and the slot hypothesis deserves a second look.
