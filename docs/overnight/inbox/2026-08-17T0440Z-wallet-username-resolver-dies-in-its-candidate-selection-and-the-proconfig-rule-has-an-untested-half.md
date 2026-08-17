# `wallet-username-resolver` dies in its CANDIDATE SELECTION — and chasing why exposed an untested half of this repo's `statement_timeout` rule

Filed 2026-08-16 21:40 PT / 2026-08-17 04:40Z (Claude Code, interactive), continuing the sentinel
digest work.

---

## The pipeline

`wallet-username-resolver` is the worst-rate remaining `high` alert: **68 of 90 runs failed (75.6%)
over 2 days**, every one `canceling statement due to statement timeout`.

**It is not the lookup loop that dies — it is the query that picks what to work on.** The route
(`app/api/cron/resolve-wallet-usernames/route.ts:105`) opens with a single bare
`.rpc("wallet_usernames_unresolved", { p_limit: 300 })` and returns early on error, so a failing
run never reaches the per-address loop. Every failed run reports `rows_found: 0`, `resolved: 0`,
`errored: 0` — it found nothing because it never got the list.

Measured cost of that one selection call (`pg_stat_statements`, 88 calls):

| metric | value |
|---|---|
| mean | **16,811 ms** |
| max | **58,206 ms** |
| total | 1,479 s |
| blocks read | 2,228,161 |
| buffer hit | **65.2%** |

⚠ **The work it gates is trivial.** Successful runs finish in 9.6–33.7 s and resolve **0–5
addresses** out of a 300 batch. So the platform is spending up to ~58 s of a saturated instance's
IO to discover that there is almost nothing to do.

**This is the "the selection query is the expensive part" shape already documented here** for
`topshot-wmc-fossil-drain` (whose `targets:` step is what times out) and for the retired
`topshot-flowty-unmapped-drain` (where proving emptiness scanned the whole open backlog every
tick, and *an empty result was the most expensive case*). **The lever is the selection query or
the batch size — never the clock.**

## ⚠ The `statement_timeout` finding, stated with its limits

`wallet_usernames_unresolved` declares **`statement_timeout=60s`** in its `proconfig`. The failures
land at **60,150 / 60,336 / 62,216 ms**, and the statement's own `max_exec_time` is **58,206 ms**.

That sits awkwardly against two facts:

- `service_role` (what `supabaseAdmin` assumes) carries **`statement_timeout=30s`**.
- CLAUDE.md states, as a canonical rule backed by two prior probes and a census of **195**
  functions, that a function-level `SET statement_timeout` **is inert**.

If the 30 s role ceiling bound this path, the statement could not have run 58 s.

**What I measured (both probes, live, this session):**

| probe | result |
|---|---|
| function declares `1s`, sleeps `3s`, outer budget `2min` | **slept fine → a LOWER declaration is INERT** |
| session set to `1s`, function declares `30s`, sleeps `3s` | **canceled → a HIGHER declaration is INERT too** |

So the canonical rule **reproduces exactly** — in the case I could test.

⚠ **But both probes share a limitation that is the whole point: the timer was ALREADY ARMED by an
outer `SELECT` before the function was entered.** PostgreSQL arms `statement_timeout` at the start
of a top-level statement and does not re-arm when a GUC changes mid-statement, so that is the
expected result and my probes only confirm that half.

**The PostgREST path is NOT the same shape and I did not test it.** PostgREST issues its own
statement, applies role settings via `SET LOCAL`, and invokes the function as the statement — and
the live evidence (58.2 s observed under a 30 s role ceiling, against a declared 60 s) suggests the
effective budget there is **60 s, i.e. the declaration**. I could not reproduce that from an MCP
connection, which runs as `postgres` with the 2 min global budget and cannot model
`authenticator` → `SET LOCAL ROLE service_role`.

**Ruled out as the source of ~60 s:** our own retry (the call site is a bare `.rpc()`, no
`rpcWithRetry`/`withQueryDeadline`), a Vercel kill (`maxDuration = 120`), and the role ceilings
(anon 3 s, authenticated/authenticator 8 s, service_role 30 s, cron_heavy 600 s, global 120 s —
none is 60).

⚠ **Why this matters beyond one pipeline:** CLAUDE.md's rule is what tells a future session that
tuning a function's declared timeout is a guaranteed no-op, and **47 functions declare more than
the global 120 s** on that basis. If the declaration DOES bind on the PostgREST path, that rule is
correct for pg_cron/`CALL` paths and wrong for the route path — which is most of the product.
**Do not weaken the rule on this evidence alone, and do not act on it as though it were settled.**

### The experiment that would settle it (needs a service-role connection, not MCP)

Create two throwaway SECDEF functions that just `pg_sleep(45)`, one declaring
`statement_timeout=60s` and one declaring nothing, grant EXECUTE to `service_role`, and call each
**through PostgREST** with the service-role key. If the declaring one survives 45 s and the bare
one dies at 30 s, the declaration binds on that path and CLAUDE.md's rule needs a scope
qualifier. Cheap, decisive, and it must be run through the HTTP path — a direct psql connection
cannot reproduce it.

## Recommended fix, independent of which ceiling binds

Neither candidate ceiling is the defect. **Profile and bound `wallet_usernames_unresolved`**: at
65.2% buffer hit and 2.2 M blocks read to return ≤5 usable rows, it is reading far more than it
needs. Likely the same fix shape as the `backfill_wmc_fmv_confidence` repair already recorded here
(a `LIMIT` that bounds rows EXAMINED rather than rows RETURNED, so it degrades to a full scan once
the queue drains). ⛔ **Do not raise the declared timeout** — that is the one change guaranteed to
be either inert or actively harmful, since a longer run holds a pooled connection longer on the
instance whose saturation is the root cause.

⚠ Not investigated: `raise_impossible_parallel_circ`, the other outlier from the same sweep —
19.0 M blocks read at a **6.3% buffer hit ratio**, mean 45.8 s, 120 calls. Near-total disk.
