# Correction to the `get_allday_unresolved_pulls` prescription — the `ORDER BY` is load-bearing, and dropping it would break the only useful work this pipeline does

Claude Code, interactive, 2026-08-13 ~11:45 PT (18:45Z). Read-only for this item; **no DB or code change.**

Follow-up to [`2026-08-13T1730Z-disk-read-ranking-and-the-pack-rips-plan-defect.md`](2026-08-13T1730Z-disk-read-ranking-and-the-pack-rips-plan-defect.md).
That file's **measurement is excellent and its index verdict is right** — the index was correctly built,
correctly measured, and correctly reverted. This corrects only its **prescription**, which I was about
to act on.

## The prescription, as filed

> **Drop the ordering.** The function exists to hand a drain 300 rows of work. If the newest 20k rips
> are all resolved, "newest first" is sorting 497k rows to pick from a set where recency is meaningless.

⚠ **Recency is not meaningless — it is the entire reason this pipeline resolves anything.** Dropping the
`ORDER BY` would have converted a working forward resolver into a job that grabs 300 permanently-
unresolvable historical rows every tick, forever.

## The measurement that establishes it

`allday_pack_pull.updated_at` is stamped when a row gets its `edition_id`, so resolution age is directly
observable:

| resolved on | n | avg age at resolution |
|---|---:|---:|
| 2026-08-13 | 90 | **3.3 d** |
| 2026-08-12 | 68 | **1.8 d** |
| 2026-08-11 | 61 | **1.3 d** |
| 2026-08-10 | 63 | **1.5 d** |
| 2026-08-09 | 207 | **1.5 d** |

**Every row this drain resolves is 1–3 days old.** It is a *forward resolver for newly-arriving pulls*,
and `ORDER BY r.block_height DESC` is the mechanism that makes it one. The 08-01 ledger note — "local
derivation is exhausted, the residue needs the un-deployed hydrator" — is exactly right, and the
consequence is that **the ordering is the only thing standing between this job and total futility.**

## The number that reframes the whole item

| | |
|---|---:|
| unresolved rows in `allday_pack_pull` | **1,119,018** |
| resolved per day | **~90** |
| **time to drain at current rate** | **~34,000 days (~93 years)** |
| disk read per day (41.1 h window, 43 calls × 984 MB) | **24.1 GB** |
| **cold disk read per resolved row** | **~274 MB** |

⚠ Note the backlog is **1,119,018**, not the 644,282 the plan estimate showed — the planner's row
estimate was itself stale, which is worth remembering when reading any `EXPLAIN` on this table.

So this is not "a slow query that needs an index." It is **~2.8% of all disk reads on an IO-throttled
instance, spent at ~274 MB per useful row**, and no index fixes that ratio because the ratio is set by
the *work*, not the *plan*.

## ⚠ The obvious replacement ordering is also a trap — and the density check is what caught it

Applying the 1730Z file's own lesson (measure density at the head of the ordering **before** building),
`ORDER BY allday_pack_pull.created_at DESC` looked ideal — it needs no `pack_rips` join for the sort, so
it would delete both the seq scan and the 497k-row sort at once. The density check is perfect:

```
newest 20,000 unresolved by created_at:  20,000 scanned,
                                         20,000 with opener_address,
                                         20,000 fully qualifying   -- vs 0/20,000 for block_height
```

**A `LIMIT 300` on that ordering stops after ~300 rows.** By the 1730Z file's criterion it passes.

⚠ **And it is still wrong, for a different reason: `created_at` is INGEST time, not pull time.**

| day | unresolved rows *created* |
|---|---:|
| 2026-08-13 | 1,778 |
| 2026-08-12 | 9,411 |
| 2026-08-11 | 6,722 |
| 2026-08-10 | 15,648 |
| 2026-08-09 | **117,033** |
| 2026-08-08 | 84,653 |
| 2026-08-07 | 98,503 |
| … Jul-31 → Aug-09 | 60k–117k/day |

A backfill ran hard Jul 31 → Aug 9 and has since tapered. So `created_at DESC` orders by *when we
ingested the row*, and its head is contaminated by backfilled historical pulls — the same residue that
does not resolve. This is the catalogued **"derived tables can't key on business time"** failure with the
polarity reversed: here the *ingest* clock is the misleading one.

**Durable, and it generalises past this query:** a density check proves an ordering is *cheap*. It does
not prove the ordering is *right*. The 1730Z index failed the cheapness test; `created_at` passes it and
fails on semantics. **Both checks are required, and they are independent.**

## Why I did not ship a fix

The correct ordering has to track *whatever makes a pull resolvable*, and that lives in
`resolve-allday-pull-editions` — which is **ungitted** (not in `supabase/functions/`), so its resolution
mechanism cannot be read from the repo. Per the `get_edge_function` rule in CLAUDE.md I did not pull the
deployed source to find out: it returns the full `index.ts` including the hard-coded gate literal, and a
fact-shaped question does not justify a secret-shaped answer.

⚠ **Related, and unavoidable if anyone re-runs my steps: `SELECT command FROM cron.job WHERE jobid=22`
echoes the live `?key=` gate literal in its URL.** That is the same "secret rides along in a payload you
did not ask for" shape as the `get_edge_function` trap, on a table nobody flags as sensitive. **Select
`jobname, schedule, active` and leave `command` out unless you specifically need it** — and when you do
need to compare a key, use the md5-fingerprint method rather than reading it.

## What to do instead — in priority order

1. **Decide whether this job should run at all.** At 93 years to drain, the backlog is not a backlog; it
   is permanent residue pending the hydrator. The forward-resolution half (~90 rows/day) is genuinely
   useful and worth keeping. The precedent for the rest is already set twice in this repo:
   `evm-transfers-ingest` (cron disabled as pure waste) and `sync-sales-ingest-dune` (schedule retired,
   route kept). ⚠ **Do not simply disable jobid 22** — that would stop the forward resolution too.
2. **If it stays: split forward from backlog.** A forward resolver bounded to pulls whose `pack_rips`
   row arrived recently needs no 1.1M-row sort. That is a query-shape change, and it is
   `apply_migration`-shippable — **after** reading the edge fn's resolution mechanism to confirm what
   "resolvable" means.
3. ⚠ **Give it an instrument first, whatever else happens.** `resolve-allday-pull-editions` writes **no
   `pipeline_runs` row at all** — verified zero rows over 72 h. Combined with the `pg_net_http_403`
   CRITICAL currently firing (24 calls/2 h, jobid 22 is one of the 14 gate-keyed jobs), this job is
   structurally indistinguishable from a completed no-op walk. It is the catalogued
   **"green pipeline blind to its own work"** class, and it is also why the 43-vs-79 expected call count
   below cannot be attributed.

⚠ **One number worth chasing separately:** the RPC was called **43 times in 41.1 h** against a
`9,39 * * * *` schedule that should fire ~82 times. **~52% of ticks never reach the database.** That is
consistent with the live 403, but it cannot be confirmed while the function logs nothing — item 3 is the
prerequisite for diagnosing it.

## What I did not check

- The edge function's actual resolution mechanism (ungitted; deliberately not pulled — see above).
- Whether jobid 22 is specifically among the currently-403ing jobs. `net._http_response` cannot be joined
  back to a URL, which is the documented limit of that instrument.
- Whether the ~90/day forward resolutions come from this job at all, or from
  `rpc-allday-nem-from-sales-backfill` (jobid 215, the AllDay free-lane self-heal). **The two are not
  distinguishable without item 3**, and that ambiguity is load-bearing for decision 1 — if the self-heal
  is doing the work, this job may already be pure waste.
