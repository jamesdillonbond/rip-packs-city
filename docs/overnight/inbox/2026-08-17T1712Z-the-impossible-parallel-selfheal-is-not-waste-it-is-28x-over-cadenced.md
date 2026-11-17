# `raise_impossible_parallel_circ` is NOT waste — it is real data-integrity healing running at 28× the cadence its work arrives at

Filed 2026-08-17 10:12 PT / 17:12Z (Claude Code, docs pass). Closes an item CLAUDE.md records as
**"unexamined"** in two places (`19.0 M blocks read at a 6.3% buffer hit ratio, mean 45.8 s`).

---

## What it is

pg_cron **jobid 219 `rpc-selfheal-impossible-parallel-circ`**, schedule **`52 * * * *`** (hourly),
owner `cron_heavy`. Body: for Top Shot parallel editions (`external_id ~ '::'`), find any edition
where a **sale's `serial_number` exceeds `circulation_count`** and raise `circulation_count` to
`max(serial_number)`. **Monotonic — raise only** — and it audits every change into
`impossible_parallel_circ_raises`.

That is a genuine correctness job: a circulation lower than an observed serial corrupts serial
multipliers, the special-serial boards, and the `topshot_impossible_parallel_serials` trust metric.

## The measurement

| | |
|---|---|
| calls (5.58 d, since `stats_reset`) | 132 |
| mean / max | **46.3 s / 127.2 s** |
| blocks read / hit | **20,905,882 / 1,414,317 → 6.3% hit** |
| ≈ disk read | **~167 GB over 5.58 d ≈ 30 GB/day** |
| total connection time | 1.70 h |

Over the trailing **7 days**: **168 runs** (hourly, as scheduled), **5 failed**, mean **43.6 s** —
and **only 6 runs raised anything at all (3.6%)**, for **20 rows** total. Lifetime: **147 raises**
since 2026-07-20, last one **2026-08-16 20:52Z**.

## ⚠ The finding is NOT "retire it" — I predicted that and the measurement refuted it

The shape (hourly, near-total disk reads, an expensive scan that usually returns nothing) matches
the retired `topshot-flowty-unmapped-drain` and the `wallet-username-resolver` selection query
exactly, and CLAUDE.md's own rule — *an empty result is the most expensive case* — made "this is
proving emptiness" the obvious read. **It is doing real work: ~3 corrections/day.** A
`sum(rows_written) = 0` style sweep, or a "find inert crons" ranking, would have called this waste
and destroyed live data-integrity healing.

**So this is a FOURTH meaning for a zero-output run**, alongside the three CLAUDE.md already
records: *correct-and-broken*, *wrong-because-untracked*, *correct-and-genuinely-idle*. This one is
**correct, valuable, and over-cadenced** — zero output on 96.4% of runs and real output on 3.6%.

## The actual defect: cadence, not existence

The work arrives in roughly **6 bursts per week**. Polling for it **168 times per week** costs ~28×
the IO the work requires, on the 2 GB disk-IO-throttled instance whose saturation is this
platform's documented root cause.

**Recommendation: cut `52 * * * *` → `52 */6 * * *`** (168 → 28 runs/week, ~6× IO cut).

Why that is safe, each checked rather than assumed:

- **Offenders ACCUMULATE and the function is idempotent + monotonic**, so a later run corrects
  exactly the same rows. The only cost is up to 6 h of latency on a correction.
- **Nothing keys on this job's freshness** — measured: **0** `pipeline_cadence_watchlist` arms
  matching `%impossible%`/`%selfheal%`, **0** views reading `impossible_parallel_circ_raises`,
  **0** other functions reading the audit table, **0** other functions calling the self-heal. ⚠ This
  check is not ceremony: it is exactly the step whose omission produced the live
  `board_mv_refresh_stale_hours` breach (an 8 h threshold left un-re-derived after a 6-hourly
  cadence cut).
- **The only downstream consumer refreshes 6-hourly anyway.** `topshot_impossible_parallel_serials`
  is written by leg **324**, schedule `48 0,6,12,18` — so hourly self-healing buys nothing the trust
  board can observe.

## ⛔ What NOT to do

- ⛔ **Do not make it incremental on `sales.ingested_at`.** CLAUDE.md: there is **no index on
  `sales.ingested_at`**, so any predicate on it seq-scans the multi-million-row partitions — strictly
  worse than the current scan.
- ⛔ **Do not substitute `sold_at`** to get an indexed window. `sold_at` is market time and the
  history backfills land months-old rows continuously (the same asymmetry that makes the `sold_at`
  keying load-bearing for `ufc_flow_revival_sales_30d`), so a `sold_at` window would silently skip
  offenders introduced by a backfill. That is a correctness gap traded for IO.
- ⛔ **Do not raise its declared `statement_timeout`** (it declares 120 s) — proven inert
  2026-08-17; the binding budget is `cron_heavy`'s 600 s.

## Not shipped, deliberately

This is a production cron-schedule change, and it is being filed at the end of a session that is
about to be archived — nobody would be watching for a regression. The measurement and the three
safety checks are complete; the one-line `cron.schedule` call is an operator/next-session action.
Apply per the documented recipe (`SET LOCAL ROLE cron_heavy; SELECT cron.schedule('rpc-selfheal-impossible-parallel-circ', '52 */6 * * *', 'SELECT public.raise_impossible_parallel_circ();');`
via `apply_migration` with `RESET ROLE`, which keeps the jobid and the 600 s budget).

**Revert:** re-issue the same call with `'52 * * * *'`.
