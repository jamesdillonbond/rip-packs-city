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

## Suggested next step (not taken)

Cheapest honest fix is an **outcome** check rather than a cadence one — the shape that closed
the concierge blind spot: alert on `topshot_ownership`'s max `observed_at` age (breach at, say,
72 h — two missed daily ticks plus slack), which is one indexed read and fires on exactly the
condition a collector would notice. A `pipeline_cadence_watchlist` row would **not** work here,
for reason (2) above; do not add one and consider it covered.

Worth confirming first, since it costs one query and changes the framing: whether the 08-13
(75,757 rows) → 08-14 (1,748 rows) drop is the queue legitimately draining or the walk already
degrading a day before it started throwing.
