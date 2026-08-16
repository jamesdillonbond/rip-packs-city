# `ownership-onchain-walk` has failed two consecutive daily ticks, and nothing watches it

**Filed:** 2026-08-16 10:34 PT / 17:34Z · Claude Code (interactive, "find a TODO and implement one") · **Not shipped — filed.**
**Surfaced incidentally** while verifying `docs/code-todos.md` #2; unrelated to that TODO.

## What

`ownership-onchain-walk` is Pipeline B of the TopShot ownership index — the per-wallet FCL
confirmation walk that re-stamps still-held Dune-attributed NFTs with a fresh `observed_at`
and counts `vanished` for sold/moved ones. Live `pipeline_runs`:

| started_at | ok | rows_written | error |
|---|---|---|---|
| 2026-08-16 13:30:42Z | **false** | 0 | `threw: stale-wallets: Timed out acquiring connection from connection pool.` |
| 2026-08-15 13:30:43Z | **false** | 0 | same |
| 2026-08-14 13:30:45Z | true | 1,748 | — |
| 2026-08-13 13:30:46Z | true | 75,757 | — |

Consequence: `topshot_ownership` still holds 267,742 rows but its freshest `observed_at` is
stuck at **2026-08-14 13:30Z**. Consumer is `lib/set-completers-board.ts` (rookie /
set-completers surfaces), so those boards are quietly ageing rather than wrong — the row set
is last-good, not empty.

## Why nothing caught it

Two independent reasons, and both are documented classes rather than new ones:

1. **No `pipeline_cadence_watchlist` entry** — `select * from pipeline_cadence_watchlist where
   pipeline like '%ownership%'` returns zero rows.
2. **A cadence watch would not have helped anyway.** The Vercel cron fires perfectly at 13:30Z
   every day; it is the work *inside* that dies. `detect_stalled_pipelines()` keys on recency,
   and a failing run still writes a `pipeline_runs` row, so recency looks healthy. This is the
   same blind spot CLAUDE.md already records for `refresh-insights-cache` and `fmv-recalc`:
   *the cron ticking is not the pipeline working.*

## Read this as saturation, not as its own bug

The error is `Timed out acquiring connection from connection pool` on the run's **first**
statement (`stale-wallets`) — the same pool-acquire family as the entity-page 45 s aborts, the
`fmv-recalc` `maxDuration` kills, and the insights board-warm failures. Per CLAUDE.md, **do not
open a separate investigation**; it is another view of the 2 GB instance's disk-IO saturation.
What makes it worth filing separately is only the *silence*, not the cause.

## ⚠ Correction (same session): the 85k → 3.7k drop is NEITHER of the two options I offered

I flagged the 08-13 (75,757 rows) → 08-14 (1,748 rows) collapse as "queue draining **or** already
degrading". **It is a third thing, and both of my hypotheses were wrong.** `wallets_walked` is
**799 on both days** — the batch is a fixed wallet COUNT (`WALLETS_PER_RUN = 800`), so
`rows_found` just tracks how many moments that particular batch of wallets happens to hold. The
walk is oldest-`observed_at`-first, so 08-13 drew a batch of whales (85,593 NFTs) and 08-14 drew
small wallets (3,708). **Expected variance, not a signal.** Do not read `rows_found` as
throughput on this pipeline; read `wallets_walked`.

*(Worth a look separately, not chased here: on 08-14 `vanished` (1,960) EXCEEDED `confirmed`
(1,748) — >50% of Dune-attributed NFTs in that batch were no longer held. Plausible for stale
small wallets that churned, but it is the one number in the series I cannot explain from batch
composition alone.)*

## Why `p_limit` is NOT the lever (pre-empting the obvious fix)

`get_stale_ownership_wallets` is:

```sql
SELECT owner_address, max(observed_at) FROM topshot_ownership
 GROUP BY owner_address ORDER BY max(observed_at) ASC LIMIT LEAST(...)
```

Measured: **Parallel Seq Scan over all 267,742 rows, 4,230 buffers, `shared hit=3` (fully cold),
2,390 ms**, 7,903 distinct wallets. The `LIMIT` sits above a HashAggregate that must consume every
row first, so **lowering `WALLETS_PER_RUN` buys identical scan cost and less work done** — the same
scan-bound shape CLAUDE.md already records for `remap_topshot_realign_miskeyed_subeditions`. Don't.

Also note 2.4 s ≠ the ~72 s the run took to fail: the error is **pool-acquire, before execution**,
so query cost is not the proximate cause and an index would not address it. (An index-only scan on
`(owner_address, observed_at)` is the tempting next idea and is probably a trap here — this table is
upserted by this very walk, so pages are non-all-visible and it would degrade to heap fetches, the
measured-and-rejected `fmv_snapshots` covering-index case. Measure before building it.)

## Mitigation SHIPPED 2026-08-16 (partial — read the caveat)

The gating read now goes through `rpcWithRetry` with a **batch-sized** backoff
(3 attempts / 20 s base / 300 s total budget) instead of a bare `supabaseAdmin.rpc()`.
`rpc-with-retry.ts:281` already classifies "connection pool" as transient; the route simply
wasn't using it. The helper's *default* (3 attempts, ~250 ms) is deliberately tuned for a page
render — and the comment at `rpc-with-retry.ts:265` records that lengthening it is "a product
call" because it trades a 500 for a ~20 s hang. **That objection does not apply here: nobody is
waiting on a daily cron**, and the route has a 720 s budget it never touched (it died at 72 s).

⚠ **This is a mitigation, not a proven fix.** If the pool is saturated for longer than 300 s the
run still fails. It converts a guaranteed total loss into a likely recovery, and a slow-but-
succeeding fetch degrades to PARTIAL progress (the queue is resumable) rather than an overrun.
**Judge it by `wallets_walked` on the next few ticks.**

## Still open — the monitoring gap (NOT taken)

The retry does nothing about the silence. Cheapest honest instrument is an **outcome** check
rather than a cadence one — the shape that closed the concierge blind spot: alert on
`topshot_ownership`'s max `observed_at` age (breach at ~72 h — two missed daily ticks plus slack),
one indexed read, firing on exactly the condition a collector would notice. ⚠ A
`pipeline_cadence_watchlist` row would **not** work, for reason (2) above — do not add one and
consider it covered. Left for a decision because it is a new alerting arm, and this repo has
already paid for one that cried wolf (`ufc_fmv_stale_hours`).
