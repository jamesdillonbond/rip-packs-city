# 52% of `net._http_response` is one HEALTHY pipeline abandoning its own replies at the 5000 ms default

**Filed:** 2026-08-18 ~18:35Z · **Class:** instrument defect. Two cron jobs. No pipeline is broken.
**Re-derived:** 2026-08-18T19:19Z — reproduces on a fresh window (see "Re-derivation" at the end).

## The measurement

`net._http_response`, last 6 h:

| bucket | n |
|---|--:|
| `timed_out = true` | **324** |
| `status_code = 200` | 282 |
| `status_code = 403` | 2 *(jobid 26, the two-tick window — see the gate-rotation finding)* |

Splitting the timeouts by the timeout the **caller** asked for:

| `Timeout of N ms` | n | DNS pegged at 5000 ms |
|--:|--:|--:|
| **5000** *(pg_net's DEFAULT — caller passed nothing)* | **168** | 35 |
| 55000 | 126 | 0 |
| 90000 | 29 | 0 |

## Attribution — it is two jobs, and only two

Of the **14** `cron.job` entries that call `net.http_*`, exactly **2** omit `timeout_milliseconds`:

| jobid | jobname | schedule | dispatches / 6 h |
|--:|---|---|--:|
| 83 | `rpc-pinnacle-mints-forward` | `6,16,26,36,46,56 * * * *` | 36 |
| 84 | `rpc-pinnacle-mints-backfill` | `*/2 * * * *` | 180 |

216 un-timed-out dispatches available; **168 observed**. `ingest-pinnacle-mints` accounts for
essentially all of it.

## 👉 And the pipeline is fine — this is proven, not assumed

`pipeline_runs`, same 6 h window:

| pipeline | runs | ok | rows_written | avg duration |
|---|--:|:--:|--:|--:|
| `ingest-pinnacle-mints-backfill` | 136 | **all true** | **63,565** | 23.4 s |
| `ingest-pinnacle-mints-forward` | 26 | **all true** | 1,529 | 18.4 s |

**Average runtime 23 s against a 5 s caller timeout.** The response is abandoned every single time, by
arithmetic, while the function goes on to complete and write. 162 successful runs and 65,094 rows
landed inside the very window in which 168 responses "timed out."

## Why this is worth a filing rather than a shrug

`net._http_response` is the table this project reaches for to answer "is the gate accepted / did the
call land." Read naively it currently says **more than half of all outbound calls fail**, and the
single largest contributor is one of the healthiest pipelines in the fleet. That is an instrument
that reports backwards under load, on a board where 26 pg_cron jobs are already failing for real.

I walked into this myself earlier today: my first verification probe for jobid 26 came back
`timed_out: true` with `DNS time: 5000.331 ms` and I could not tell a dead endpoint from a default
until I re-ran with `timeout_milliseconds := 30000`. ⚠ **`error_msg` is the only field that
distinguishes them** — `timed_out` alone cannot.

## Suggested fix — small, and NOT urgent

Give jobs 83 and 84 an explicit `timeout_milliseconds` generous enough to outlive the work
(observed max **171 s** backfill / **181 s** forward, so ~240000). pg_net is asynchronous — the cron
job returns the request id immediately (`1 row`) regardless — so a long timeout does not hold the job
open; it only decides whether the reply is recorded or discarded.

⚠ **Do not "fix" this by treating `timed_out` as benign in general.** The 126 × 55000 and 29 × 90000
timeouts are callers that asked for a real budget and did not get an answer. Those are on the
saturation board and are a different thing entirely.

⚠ Unverified, flagged not chased: `ingest-pinnacle-mints` writes 63.5 k rows / 6 h while the pinnacle
catalog gap (946 of 954 with `resolution_attempts = 0`) keeps growing. Different pipeline —
`pinnacle-nft-resolver` shows 15 failed runs in the same window. Not diagnosed here.

---

## Re-derivation (2026-08-18T19:19Z, independent session, fresh 6 h window)

The window rolled forward ~45 min, so the absolute counts move; **every structural claim holds.**

| bucket | original (18:35Z) | re-derived (19:19Z) |
|---|--:|--:|
| `timed_out` total | 324 | **321** |
| — asked 5000 ms | 168 | **168** |
| — asked 55000 ms | 126 | 122 |
| — asked 90000 ms | 29 | 31 |
| `200` | 282 | 304 |
| `403` | 2 | 1 *(one 403 aged out of the window)* |

Timeout share: 321 / 626 = **51.3%** — the "52%" headline survives on a second, non-overlapping-tail
sample. The 5000 ms bucket is unchanged at exactly 168.

**Attribution re-confirmed independently.** Queried `cron.job` with a boolean predicate only
(`command ilike '%timeout_milliseconds%'`) — never selecting the command text, since that echoes live
gate keys. Result: **14** jobs call `net.http_*`; exactly **two** return `passes_timeout = false`,
and they are jobid **83** (`rpc-pinnacle-mints-forward`) and **84** (`rpc-pinnacle-mints-backfill`).
No others. The remaining 12 all pass an explicit timeout.

**Pipeline health re-confirmed and strengthened:**

| pipeline | runs | ok=true | rows_written | avg | **max** |
|---|--:|--:|--:|--:|--:|
| `ingest-pinnacle-mints-backfill` | 148 | **148** | 63,726 | 20.5 s | **171.7 s** |
| `ingest-pinnacle-mints-forward` | 29 | **29** | 1,329 | 15.5 s | **181.1 s** |

177 runs, **zero** with `ok = false`, 65,055 rows written. The `max` column now measures directly what
the original finding cited for sizing the fix (171 s / 181 s) — those numbers are confirmed, so the
proposed ~240000 ms still clears the observed worst case with ~25% headroom.

⚠ Note on the sizing argument, stated rather than assumed: 240000 ms is chosen against **6 h of
observed maxima**, not a bound. If the backfill's per-tick work grows, this needs re-measuring — it is
a dated sample like every other number here.
