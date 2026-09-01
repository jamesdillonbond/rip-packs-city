# 🚨 `sales-counterparty-backfill` has walked past Flow's spork wall — and the wall answers **HTTP 200**, so 288 of 288 runs a day "succeed" and recover nothing

**Filed 2026-08-31 ~22:2x PT (2026-09-01 ~05:2xZ) by Claude Code from Trevor's Windows box.**
Found by a sweep for *permanently-zero* instruments, prompted by the fmv-recalc finding earlier tonight
(`2026-09-01T0530Z…`). Nothing was changed — this needs a decision and a `wrangler deploy`, neither of
which is a safe unattended action.

## The reading

`sales-counterparty-backfill` (the Cloudflare Worker) walks `sales` **newest-first** on
`sales_counterparty_backfill_state.cursor_sold_at`, decoding each tx via Flow REST to recover the seller.

| | |
|---|---:|
| runs in 24 h | **288** |
| runs with `applied > 0` | **0** |
| runs with `recovered > 0` | **0** |
| mean duration | **~115 s** |
| ⇒ runtime spent per day | **~9.2 hours** |
| rows examined per run (`batch`) | 120 |
| `cursor_sold_at` at 05:10Z | **2023-10-04T19:22** |

It is not stuck — the cursor advances every tick (05:00Z → `2023-10-04T21:13`, 05:05Z →
`20:11`, 05:10Z → `19:22`). It is walking backwards through 2023 at ~120 rows a tick, **converting
nothing**, and it will keep doing so.

⚠ This is **not** the documented throttle-wave behaviour. `sales-counterparty-backfill-second-pass`
records misses as *"throttle-transient, not undecodable"*, with ticks that *"swing 1–98%"* and recover
*"40–90 per tick"*. **0 on 288 consecutive runs is not a swing.**

## ⭐ The cause — and it is the `failed read served as HTTP 200` class, on an upstream

Flow REST does not 404 for pruned history. It returns **HTTP 200 with an empty body**:

```
GET /v1/transaction_results/<2023-10-05 hash>  ->  HTTP 200
{ "block_id": "", "collection_id": "", "execution": "Pending", "status": "", "status_code": 0 }
```

`execution: "Pending"`, `status: ""`, **zero events**. A worker that checks `res.ok` sees success, finds
no `<Contract>.Withdraw` event, records an ordinary miss, and advances the cursor — exactly as it would
for a throttled request. **An unreachable era is indistinguishable from a transient miss.**

**Positive control, fired against the same endpoint minutes apart:**

| era | HTTP | `execution` | `status` | events | `Withdraw` |
|---|---|---|---|---:|---|
| **2026-09-01** (recent) | 200 | `Success` | `Sealed` | **23** | ✅ |
| **2023-10-05** (cursor) | 200 | **`Pending`** | `""` | **0** | ❌ |

## The wall, bracketed

| probe date | result |
|---|---|
| 2023-10-05 | **EMPTY (pruned)** |
| **2023-11-01** | **EMPTY (pruned)** |
| **2023-11-20** | **DECODABLE** (4 events) |
| 2023-12-10 · 2023-12-28 · 2024-01-15 · 2024-06-15 · 2024-12-15 | DECODABLE |
| 2025-03-15 · 2025-06-15 · 2025-09-15 · 2026-01-15 · 2026-09-01 | DECODABLE |

**Accessible history begins between 2023-11-01 and 2023-11-20** — a spork boundary. **The cursor is
already below it.** Everything the worker will touch from here on is unrecoverable through this path.

### ⛔ This corrects a recorded claim

The memory `sales-counterparty-backfill-second-pass` says Flow REST *"returns 200 back to 2024-12-31
(**no spork wall at this endpoint** — distinct from the AllDay pack-opens block-range 404 class)"*.
**There IS a wall.** It is simply invisible to a status-code check, because past it the endpoint answers
**200**, not 404. The July probe was correct about 2024-12-31 and drew the wrong general conclusion from
it — a probe that only reads HTTP status can never find this boundary, however far back it goes.
*(It is also further back than that note assumed: 2023-11-20 decodes fine.)*

## Sizing — what is and is not still recoverable

Null-seller `sales` rows carrying a transaction hash:

| | rows | share |
|---|---:|---:|
| **above the floor** (≥ 2023-11-20) — recoverable, already walked past | **433,108** | 17.8% |
| in the uncertain band (2023-11-01 → 11-20) | 61,835 | 2.5% |
| **below the floor** (< 2023-11-01) — **permanently undecodable via Flow REST** | **1,931,963** | **79.6%** |
| total | 2,426,906 | — |

Oldest null-seller row: **2020-07-28**. At 120 rows/tick the worker needs roughly **16,100 more ticks
(~56 days)** to grind from 2023-10 down to 2020 — and will recover **zero** doing it, at ~9.2 h/day of
runtime and Flow REST egress.

The 433,108 above the floor are the population the memory describes: already attempted on the way down
and missed to throttle waves, and **genuinely recoverable on a second pass.**

## Options — ⛔ none applied, and one ordering trap

1. **Bound the walk at the spork floor.** The real fix. Worker code, so it needs `wrangler deploy` from
   `workers/sales-counterparty-backfill/` — ⚠ **Cloudflare Workers do NOT auto-deploy from `main`**, and
   the memory warns to `grep` the source for an expected marker first because wrangler ships stale files.
2. **Second-pass sweep** for the 433k above-floor misses — one statement, already documented:
   `update sales_counterparty_backfill_state set cursor_sold_at = null where id = 1;`
3. **Supersede with Dune** `flow.cadence_events` — already queued in the memory at **~167 credits** for
   the entire 2024-26 history, versus this multi-week free grind. ⚠ Dune bills on **DATAPOINTS**, and one
   ownership walk already consumed 87.7% of a month, so price it before running.

🚨 **The ordering trap: (2) WITHOUT (1) reproduces this exact state.** Resetting the cursor restarts the
newest-first walk; it re-attempts the recoverable 433k, then crosses the same wall and resumes grinding
undecodable history — roughly a fortnight of useful work followed by an unbounded zero-yield walk. **Do
(1) first, or do (2) knowing you will be back here.**

## The transferable rule

⚠ **A cursored backfill needs a FLOOR, not just a cursor.** Newest-first walks terminate only by running
out of data; this one has no lower bound, so it walks off the edge of what its upstream can serve and
keeps going. And ⛔ **when the upstream signals "I cannot serve this" with a 200, `res.ok` is not a
liveness check** — the discriminator has to be the *body* (`execution !== "Success"`, or zero events),
which would also have made this self-reporting from day one.
