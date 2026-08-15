# The entity-page timeouts are TWO families, and the biggest one is not a slow query

**Filed** 2026-08-15 04:50Z by Claude Code (interactive), while looking for a code-side lever on
`JAVASCRIPT-NEXTJS-1Z`. **The classification half shipped** (`withDeadline` normalization); the
capacity conclusion below is **read-only and not acted on** — the remedy is a pooling/concurrency
decision, not a query change.

## The split

Every open entity-page timeout on the Sentry board carries one of two messages, and they are
**different failures with different fixes**. Nothing in the existing filings separates them.

| Sentry | page | message | family |
|---|---|---|---|
| **NEXTJS-1Z** (86 users) | pack dist | `TimeoutError: The operation was aborted due to timeout` | **client bound (45 s)** |
| NEXTJS-26 (140 events) | edition | `TimeoutError: … aborted due to timeout` | client bound |
| NEXTJS-23 | player editions | `TimeoutError: … aborted due to timeout` | client bound |
| NEXTJS-22 | set detail | `TimeoutError: … aborted due to timeout` | client bound |
| NEXTJS-20 | player detail | `TimeoutError: … aborted due to timeout` | client bound |
| NEXTJS-27 | series detail | `canceling statement due to statement timeout` | **Postgres 57014 (30 s)** |
| NEXTJS-24 | set editions | `canceling statement due to statement timeout` | Postgres 57014 |
| NEXTJS-1Y (87 events) | team detail | `canceling statement due to statement timeout` | Postgres 57014 |

## Why the first family cannot be explained by query cost

Two measurements, both live 2026-08-15:

1. **`service_role` carries `statement_timeout=30s`** (`pg_roles.rolconfig`; anon 3 s,
   authenticated 8 s). A statement that is genuinely *running* is killed at 30 s and returns
   57014 — i.e. it lands in the SECOND family by construction.
2. **No production call comes close.** `pg_stat_statements` over a 3 d 09 h window
   (reset 2026-08-12 01:34Z, so it covers firings from 2 h ago) — the PostgREST-shaped rows are
   the real traffic:

   | shape | calls | mean | **max** |
   |---|---|---|---|
   | `WITH pgrst_source …` | 1,523 | 590 ms | **13,636 ms** |
   | `WITH pgrst_source …` | 12,048 | 141 ms | **7,784 ms** |
   | `WITH pgrst_source …` | 1,107 | 237 ms | **4,226 ms** |

   (The 25.8 s / 20.4 s / 18.9 s rows in the same table are hand-run `explain (analyze, buffers)`
   probes from previous investigations — 1–2 calls each, not traffic.)

So a request that dies at our **45 s** bound spent >45 s without Postgres ever killing it at 30 s,
while the heaviest real statement completes in 13.6 s. **The time is not going into statement
execution.** What is left is connection acquire / a stuck socket — which is exactly the case the
45 s bound was written for ("Anything still outstanding past 45 s is therefore not a statement —
it is a stuck acquire or a dead socket, the one case with no other stop condition").

## Why this matters for what has already been tried

⚠ **Two query-level fixes have now been proposed for NEXTJS-1Z, and neither could have closed it.**
The `collection_id`-to-reach-the-covering-index change was measured and rejected as a regression
(2026-08-14). The `computed_at <= now()` partition pruning shipped and took the hero leg
9,131 → 6,308 buffers — a real improvement, correctly recorded as *not* closing the issue. This
filing explains **why** neither moved it: making a 13 s statement faster does not shorten a wait
that is not the statement. `max_connections` is 90 on a 2 GB Small instance.

**Do not spend another session on `get_pack_detail_bundle`'s plan.** The next useful measurements
are on the pool, not the query:
- `SELECT count(*), state FROM pg_stat_activity GROUP BY state` sampled during a firing window;
- Supavisor pool size vs. concurrent lambda count (the pack page fans out Suspense sections onto
  their own connections *by design*, which is a concurrency multiplier per page view);
- whether firings correlate with the pg_cron heavy jobs (jobid 302/303 are the #1 and #2 disk
  readers and run at `2-59/5` and `7-57/10`).

## What DID ship from this (2026-08-15)

`withDeadline` in `lib/analytics/rpc-with-retry.ts` produced **two different errors** for one
event, and only one of them was reachable by a test:

- the race guard resolves `timeoutError()` → `code: RPC_TIMEOUT`, the constant the module exports
  precisely so "a bound we imposed is greppable in logs and never mistaken for something the
  server reported";
- the `.abortSignal(AbortSignal.timeout())` path resolved whatever supabase-js made of the
  DOMException — `TimeoutError: The operation was aborted due to timeout`, **no SQLSTATE, no
  `RPC_TIMEOUT`**. In production the abort wins the race, so the shape that actually escaped had
  none of the properties the module advertises. That string is the Sentry *title* of all five
  first-family issues, which is why they read like a browser bug.

⚠ **No test could have caught it.** The module's own comment records that every mock in the repo
implements `.rpc` as a bare async function with no `.abortSignal` — so every test takes the guard
branch *by construction*, and the guard branch was already correct. Same shape as the other blind
spots in this repo (the anon leak guard's `isPublicPath` derivation, the OG sweep's `og/insights`
walk): a mechanism's own derivation deciding what it is able to observe.

Fixed by normalizing both exits to one shape, plus `__tests__/rpc-with-retry-abort-shape.test.ts`
with a mock that DOES implement `.abortSignal`. A non-abort rejection is deliberately re-thrown
rather than folded into `error` — that would swallow genuine programming faults behind a plausible
"timed out" story. ⚠ A rejection also used to escape `rpcWithRetry` entirely, past every caller
that destructures `{ data, error }` — a contract break, not just a wording difference.

**This is an observability fix, not a capacity fix.** It changes what the five issues are *called*
and makes them classifiable; it does not reduce their number by one.
