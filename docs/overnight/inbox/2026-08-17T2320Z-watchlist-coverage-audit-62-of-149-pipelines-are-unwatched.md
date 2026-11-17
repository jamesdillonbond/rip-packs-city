# Watchlist coverage audit: 62 of 149 active pipelines are unwatched, 5 of them have zero successes — and a curated list is why

Filed 2026-08-17 16:20 PT / 23:20Z (Claude Code, interactive). **This exists because three unrelated
investigations in one session each ended at "…and it is on no watchlist"** (`topshot-wmc-fossil-drain`,
`sync-nba-projections`, the UFC pipelines). Three anecdotes is a pattern; this replaces them with an
enumeration.

## The numbers

| quantity | value |
|---|---|
| distinct pipelines that RAN in the last 7 days | **149** |
| `pipeline_cadence_watchlist` rows / active | 102 / **83** |
| **ran but on NO watchlist row** | **62 (41.6%)** |
| …of those, **zero successes in 7 days** | **5** |
| watchlisted but **did not run at all** in 7 days | **15** |

⚠ **This is the "prefer a directory/tree walk over a curated list" rule with a number on it.** The watchlist
is curated, so its membership drifts from reality in *both* directions at once: 62 live pipelines it cannot
see, and 15 entries pointing at pipelines that no longer run.

## The 5 that are unwatched AND failing 100%

| pipeline | runs 7d | ok | rows written | last error |
|---|---:|---:|---:|---|
| `sync-nba-projections` | 17 | 0 | 0 | `all_upstreams_failed` |
| `drain-conflated-subeditions` | 4 | 0 | **1,999** | `canceling statement due to statement timeout` |
| `topshot-misattrib-drain` | 1 | 0 | **888** | `rekey: upstream request timeout` |
| `ownership-sync-dune` | 1 | 0 | **114,083** | `stale cache: refresh did not complete (execute HTTP 402)` |
| `topshot-wmc-fossil-drain` | 1 | 0 | 0 | *(retired 2026-08-17 — measured empty)* |

⚠ **FOUR OF THE FIVE WRITE ROWS WHILE FAILING, AND THAT MATTERS FOR THE ARM WE ALREADY SHIPPED.** The
`Pipeline Success Coverage` arm requires **`runs > 0 AND zero successes AND zero rows written`** — the
`rows_written` term was added deliberately because zero-successes alone produced 4 false positives, all
graceful degradation. **But that same term makes the arm blind to "writes rows and never completes"**, which
is 4 of these 5. Watchlisting them would surface only `sync-nba-projections`. **This is not an argument to
remove the term** (it earned its place); it is the arm's honest coverage boundary, and it was not written
down.

## `ownership-sync-dune` — the most interesting of the five

Weekly. **`HTTP 402` — Payment Required — on 2026-08-10 and 2026-08-17**, after succeeding 2026-08-03. That
is an exhausted paid-API quota, i.e. a **billing-level** failure with no engineering fix.

⚠ **And it is perfectly camouflaged: `rows_written = 114,083` on the success AND on both failures — byte
identical.** Any `rows_written`-based health read shows a flawless pipeline. **An identical row count across
a success and a failure is the signature of a stale cache being rewritten**, the same shape as the
documented "a byte-identical HTTP response is as much the signature of a cache hit as of a correct change".

⚠ **DO NOT escalate this as "TopShot ownership is going stale" — I checked, and it is not.** `topshot_ownership`
is **267,742 rows, newest `observed_at` 2026-08-17 13:30Z = 0.4 days old**, carrying both `dune` and
`onchain_walk` sources. The **on-chain walk half recovered** (it had failed 08-15/08-16 per `docs/code-todos.md`)
and is currently carrying the data on its own. **The real state is degraded REDUNDANCY, not an outage** — and
the surviving leg is shaky: `ownership-onchain-walk` is **1 ok of 3 runs** in 7 days. **A two-leg design is
down to one flaky leg, and nothing watches either.**

## Suggested next steps, cheapest first

1. **Decide the watchlist's derivation, not its membership.** Adding 62 rows by hand recreates the same drift
   in a month. The durable fix is to derive candidates from `pipeline_runs` (anything that ran in N days and
   is not explicitly suppressed) and let suppression be the curated list instead — a ban-at-zero shape rather
   than an allowlist.
2. **Write down the success arm's coverage boundary** (the `rows_written` term excludes partial-write
   failures) wherever the arm is documented, so the next audit does not rediscover it.
3. **`ownership-sync-dune` 402 is an owner call** — Dune quota/billing, not code.
4. **Prune the 15 watchlisted-but-silent entries**, or confirm they are intentionally retained; a watchlist
   arm pointing at a pipeline that no longer runs is either noise or a missed retirement.
