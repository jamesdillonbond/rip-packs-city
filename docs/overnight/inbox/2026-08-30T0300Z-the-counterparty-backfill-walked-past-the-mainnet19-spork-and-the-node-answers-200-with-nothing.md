# 🚨 `sales-counterparty-backfill` walked past the mainnet19 spork — and the access node answers **200 with nothing**, so nothing can tell

**Filed 2026-08-29 ~20:00 PT (2026-08-30 03:00Z). Status: MEASURED AND ROOT-CAUSED. NOTHING
SHIPPED — the fixes are in a Cloudflare Worker that self-schedules via CF Cron Triggers, which
this session can neither deploy nor stop.**

## The signal

`sales-counterparty-backfill` runs every 5 min and reports `ok: true` on 562 of 571 runs in 48 h.
Split into 6-hour buckets, the applied count is a **step change, not a decay**:

| bucket (UTC) | runs | applied | rows_found | cursor range walked |
|---|---|---|---|---|
| 08-28 06:00 | 72 | **4,619** | 8,640 | 2023-11-11 → 11-14 |
| 08-28 12:00 | 71 | **4,616** | 8,160 | 2023-11-08**T14:39** → 11-11 |
| **08-28 18:00** | 72 | **0** | 8,640 | 2023-11-06 → 2023-11-08**T14:17** |
| 08-29 00:00 → 08-30 00:00 | 311 | **0** | ~36,600 | 2023-11-06 back to 2023-10-30 |

**33 hours, ~383 runs, ~36,600 rows found, ZERO applied**, at ~90 s per run — while `rows_found`
never dips and the cursor keeps advancing.

## ⛔ The obvious attribution is WRONG, and it is the one I would have filed

`public-api.nbatopshot.com` went 530 at **2026-08-28 ~17Z** — one hour before this step change, on
the same evening, and I have spent the day tracing that outage. **It is not the cause.** This worker
never touches Top Shot: it decodes from `https://rest-mainnet.onflow.org/v1/transaction_results`.
⭐ **The timing coincidence is close enough to have been convincing, and it is a coincidence.**

## ✅ The cause, bracketed to 22 minutes by the pipeline's own cursor

The last productive cursor is **2023-11-08T14:39Z**; the first fully-zero bucket ends at
**2023-11-08T14:17Z**. That is the **mainnet19 spork boundary**, which CLAUDE.md records only as
"~2023-11-08". **The pipeline's own telemetry dates it to a 22-minute window.**

Confirmed by a controlled probe pair against the live access node, both sides:

| tx | `sold_at` | result |
|---|---|---|
| `237797c5…a5c9` | 2023-11-08 **13:59** (pre) | **HTTP 200**, `"execution": "Pending"`, `block_id: ""`, `events: []` |
| `a9ea27a7…946f` | 2023-11-09 **00:02** (post, CONTROL) | **HTTP 200**, real `block_id`, real `collection_id`, execution data |

## 🚨🚨 The mechanism is worse than a 404, and it is this platform's own defect class arriving from OUTSIDE

**A pre-spork transaction does not 404. The access node returns `200 OK` with `execution: "Pending"`
and an empty event list** — an upstream that answers *success* with *nothing*. So:

- the decoder finds no events and records a miss,
- a miss is **indistinguishable from a genuinely undecodable row** at that layer (the worker's own
  comment says exactly this, about throttling),
- **no error is ever raised**, so the hardcoded `ok: true` at `index.ts:186` never flips,
- and `rows_written` is honest — it really is 0 — so the fleet instrument reads "idle", not "blind".

⭐ **We keep fixing `?? 0` and `200-on-error` in our own code. This is the same shape served TO us,
and it defeats a pipeline that was written carefully enough to comment on the adjacent hazard.**

## ⚠ What this does NOT mean — two overclaims I removed before filing

- ⛔ **Not permanent data loss.** The cursor advances past misses, but the rows stay NULL and the
  design's stated recovery is a later pass. Those ~36,600 rows are skipped *for this pass*, not
  destroyed.
- ⛔ **Not "14 hours of DB time per 48 h".** The 846 minutes in 48 h is the **worker's wall time**,
  which is dominated by Flow REST round-trips at CONCURRENCY 3 with pauses and a retry pass. **The
  DB share is unmeasured** — the per-tick database work is one queue read plus one
  `apply_sales_counterparty`. Do not quote a DB cost from this number.

## ⭐ The repo already owns the fix and this pipeline does not use it

`app/api/admin/backfill-topshot-buyers/route.ts` decodes historical transactions through
**`SPORK_PROXY_URL`** (`workers/spork-proxy`), whose wired sporks reach back to
`HIST_WINDOW_START = "2022-04-06T18:20:00Z"` — the mainnet17 root floor. That route also already
classifies this exact condition as **`spork_floor`** rather than a fault (hardened 2026-08-29). This
worker's `wrangler.toml` states the opposite premise as settled fact: *"Flow's public REST endpoint
is reachable directly from Cloudflare Workers (verified)"* — **true for post-spork rows, and the
walk has now left that range.**

## 👉 What is owed, and why none of it shipped here

The worker self-schedules with `crons = ["*/5 * * * *"]` **Cloudflare Cron Triggers** — no
pg_cron job, no GHA workflow, no cron-job.org entry (all three checked). **This session cannot stop
it or deploy it.** Handoff, in priority order:

1. **Honesty (small).** `ok: true` is hardcoded at `index.ts:186`. It should classify: `rows_found > 0
   && recovered === 0` is not a success. Distinguish `spork_floor` from a fault exactly as
   `backfill-topshot-buyers` does — the floor is expected, a 100% miss for any other reason is not.
2. **Stop the pointless walk (decision).** Below ~2023-11-08T14:2xZ this worker recovers nothing.
   Either bound the queue at the reachable floor, or route decodes through `spork-proxy` (reaches
   2022-04-06) and re-floor there. Until one of those lands it will walk from 2023-10-30 back to
   2020 applying zero, every 5 minutes.
3. **Then, and only then, consider a cursor reset** for the skipped corridor — it is only worth
   re-walking once the decode path can actually serve it.

⏱ **Falsifier for the root cause:** probe any tx with `sold_at` just after 2023-11-08T14:39Z and
expect a populated `block_id`; just before 14:17Z and expect `execution: "Pending"` with no events.
**Exit condition:** a run with `rows_found > 0 && recovered = 0` that reports `ok: false` (or an
explicit `spork_floor`), and a queue that no longer serves unreachable rows.
