# allday-pack-opens-backfill — it is not auth, and there is a healthy twin that proves it

2026-08-23 ~02:15Z, from Cowork. Adds mechanism to the concurrent session's filing, which correctly established *that* the lane is silent and left attribution open.

## The positive control the earlier pass did not have

`cron.job` 20 and 55 call the **same edge function**, with the **same two query parameters**:

| jobid | jobname | schedule | function | params | 72 h health |
|---|---|---|---|---|---|
| 20 | `rpc-allday-pack-opens-forward` | `9,39 * * * *` | `functions/v1/ingest-allday-pack-opens` | `key`, `mode` | **129 runs / 126 ok** |
| 55 | `rpc-allday-pack-opens-backfill` | `6,16,26,36,46,56 * * * *` | `functions/v1/ingest-allday-pack-opens` | `key`, `mode` | **38 runs / 7 ok** |

Same function, same gate-key surface, same host, same `timeout_milliseconds := 90000`. One is healthy. **That eliminates the whole auth branch by construction** — the gate key, the deploy, DNS to that host, and pg_cron dispatch are all proven good by the twin, without reading a single secret. The two differ only in `mode`.

(Read safely: I selected booleans, a `timeout_milliseconds` substring, `https://[^'?]*` — which stops before the query string — and parameter *names* via regex. The `command` body, which carries `key=`, was never selected.)

## What is actually failing

Every failing run since 2026-08-20 02:16Z carries a byte-identical `extra`:

```
start 84675248 · end 84700247 · scanned_floor 84700248 · routed "spork" · floor 65264619
queries 1 · tx_fetched 0 · progress_blocks 0 · spork_available true
transient true · skipped_permanent false · partial false
scan_err "events 84699998-84700247 status 0"        (some runs: status 503)
```

`84700247 − 84699998 + 1 = 250`, and that chunk's end **is** the span's end. So the scan walks a ~25,000-block span in 250-block chunks and dies on **the final chunk**, every time. `status 0` is no HTTP response at all; `status 503` is the upstream refusing.

**The lane then re-requests the identical window.** `transient: true` with `skipped_permanent: false` means a window that has failed for three days is still classified as a temporary blip, so `progress_blocks: 0` on every attempt and the cursor cannot move past it. The telemetry already has a `skipped_permanent` concept — it just never fires.

Durations cluster at **46.7–46.9 s** across runs hours apart. That regularity is a fixed internal timeout, not DNS jitter.

## Two things that are separate failures, not this one

- **`cursor_read allday_pack_opens_backfill: Timed out acquiring connection from connection pool`** — 2 runs, 62.0 s and 63.6 s. That is the DB-saturation class, unrelated to the block window.
- **The NULL-status responses are not this lane.** `net._http_response` shows **128 NULL/timeout in the last 3 h** against 528 × 200 and 5 × 504. Job 55 fires 6×/h, so it can account for at most ~18 of the 128. The bulk belongs elsewhere — consistent with the earlier finding that one healthy long-running pipeline dominates that table. Attribution to job 55 remains impossible (`net.http_request_queue` is pruned on response) and is *not needed* — `pipeline_runs.extra` names the failing range directly.

## The part that is worse than "silent"

Last `pipeline_runs` row: **2026-08-22 13:16Z**. Dispatches continue at 6/h. So roughly **78 ticks since then have written no row at all** — they are dying before the terminal write, which is a different and less visible state than the recorded failures above. `runs_72h` = 38 against ~432 expected (8.8%) is that gap, not a low success rate.

## Where the cursor actually is

The cursor is **not** frozen in the long run — 7 distinct `start` values appear in 72 h, ascending 84675248 → 84680498, so earlier smaller bites did progress. The recent shape is different: a single ~25,000-block span whose tail chunk is unservable. Whether the span width is configured or derived is in the edge-function source, which I did not read.

⚠ **Labelled honestly:** everything above is read from `cron.job` and `pipeline_runs.extra` on production. The chunking interpretation is arithmetic on the reported numbers, not a reading of `supabase/functions/ingest-allday-pack-opens`. Confirm against the source before changing behaviour.

## Suggested fix, for whoever holds the deploy

Make a repeatedly-failing window permanent rather than transient: after N consecutive failures on the same `(start, end)`, set `skipped_permanent` and advance the cursor past that chunk, recording the skipped range. The flag exists; the escalation does not. Without it, one 250-block window the access node will not serve stops a backfill indefinitely — and does it while reporting `transient: true`, which reads as "it will sort itself out."

Second, smaller: a tick that dies before its terminal write is invisible. The heartbeat pattern already used on the four `maxDuration=800` routes would separate "never fired" from "died mid-run" here too.
