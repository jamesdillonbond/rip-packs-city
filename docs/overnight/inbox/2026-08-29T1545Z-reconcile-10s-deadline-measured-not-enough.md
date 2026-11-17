# The 10 s reconcile deadline: the measurement 20260828225925 asked for — and it says no

**Filed 2026-08-29 ~15:45Z (08:45 PT). Status: MEASUREMENT TAKEN, NO CHANGE SHIPPED.**

`supabase/migrations/20260828225925_audit_20260828_aggregate_saved_wallet_stats_drop_correlated_tier_subquery.sql`
cut `aggregate_saved_wallet_stats`'s correlated top-tier subquery (-30% total buffers,
-45% reads on the one wallet it measured) and closed with:

> ⚠ THE LEVER IS CUTTING WORK, NOT RAISING THE DEADLINE. […] whether 10 s is then
> enough is a MEASUREMENT to take afterwards, not an assumption to ship on.

## The measurement

Change point 2026-08-28 23:05Z (migration applied 22:59Z). 24 h either side,
`pipeline_runs` for `reconcile-saved-wallet-stats`:

| | runs | ok | avg `wallets_done` | max | avg queue | avg `elapsed_ms` |
|---|---:|---:|---:|---:|---:|---:|
| before | 22 | 4 | **1.27** | 4 | 9.7 | **25,764** |
| after | 15 | 4 | **1.20** | 4 | 8.3 | **26,331** |

**10 s is not enough, and the query cut did not change that.** `wallets_done` did
not move; per-run elapsed did not move. The sweep still does ~1 wallet per hourly
run against a queue of ~8, and still logs `ok=false /
soft_deadline_reached_partial_sweep_committed` on ~4 runs in 5.

⚠ **`oldest_cache_h` CANNOT be compared across this change point** and is
deliberately omitted from the table above. The same 08-28 batch also re-scoped
that metric to the queue's own population (it previously read every
`saved_wallets` row and was pinned by ~21 rows the sweep cannot touch by design).
Pre-fix it averages 152.0 h with a max of 456.8 h; post-fix 8.6 h with a max of
13.4 h. That is two instruments, not one improvement — pooling them would
manufacture a 17x "win" out of a metric repair. Post-fix only: 6.0–13.4 h against
a `p_min_age_minutes` target of 6 h.

## Why raising `p_max_seconds` is still the wrong lever — now with the arithmetic

The job runs as `postgres` under the **global 120 s `statement_timeout`, applied
cumulatively across the whole CALL** (internal `COMMIT`s do not reset it on this
instance — 20260816014000 observed it dying at exactly 120.0 s). The soft deadline
is checked only BETWEEN wallets, so the bound that matters is:

    last-entry time + worst single-wallet cost  <  120 s

With the worst wallet measured at 105 s (20260816014000), a 10 s entry deadline
gives 10 + 105 = 115 s. **30 s would give 135 s and put the straddle-abort back.**
The 10 s is not timid; it is the largest value the worst-case wallet allows.

Note the shape: the deadline is measured from procedure ENTRY, not from the top of
the loop, so the zero-pass `UPDATE` and the queue `SELECT` are charged against it
too. That is also deliberate — it is what makes the bound cumulative — and moving
it to the loop would buy wallets by spending the very headroom the 120 s bound
needs. Do not "fix" it.

## The untried lever, stated so the next session does not re-derive the two dead ends

Both known levers are spent: the deadline cannot rise (120 s), and cutting 30% off
the query did not get a wallet under 10 s. What has never been tried is **bounding
ONE wallet instead of the whole sweep** — a `statement_timeout` on
`aggregate_saved_wallet_stats` itself (say 20 s), which would cap the worst case
and let the entry deadline rise to ~90 s, i.e. ~4–6 wallets per run instead of 1.

⚠ It is not free, and the reason it is filed rather than shipped:
- a timed-out wallet raises `57014` inside the loop, which aborts the whole CALL
  unless wrapped — and a `BEGIN … EXCEPTION` block cannot contain the per-wallet
  `COMMIT` the resumability depends on. The restructure is real work, not a knob.
- it would make some wallets **permanently unreconcilable** (any wallet that
  genuinely needs >20 s would time out on every attempt, forever, and — being
  stalest-first — would be retried first every single run). That failure mode is
  worse than the current one and needs its own escape hatch before this ships.
- per CLAUDE.md this instance's binding constraint is IO, and 4–6x the wallets per
  run is 4–6x the IO. The 08-28 migration's own reasoning applies unchanged.

## What is NOT wrong here, so nobody re-files it

- **`ok = NOT v_truncated` is not a mislabel to flip.** Two sessions (08-16,
  08-28) considered it and kept it deliberately as "the honest *did not finish*
  signal". The sentinel's `Pipeline Success Coverage` arm already handles it
  correctly — its predicate is zero-successes **AND** zero-rows-written, and this
  pipeline writes rows, so it does not fire. Relabelling would buy a tidier
  dashboard and lose the only signal that says the sweep is behind.
- **The queue is at equilibrium, not diverging.** ~8 queued, oldest 6–13.4 h,
  stable across 15 post-fix runs. Stale saved-wallet cards, not lost data.
