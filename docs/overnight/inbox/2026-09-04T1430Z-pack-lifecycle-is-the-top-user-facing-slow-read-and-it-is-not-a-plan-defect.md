# `get_pack_lifecycle` is the platform's top user-facing slow read — and it is NOT a plan defect, so do not optimise it

**Filed 2026-09-04 14:30Z (07:30 PT) by Claude Code (cloud sandbox) · MEASUREMENT ONLY, NOTHING SHIPPED. This is a NEGATIVE finding: its value is that it stops an optimisation pass, not that it starts one.**

## 1. What production says

`get_pack_lifecycle` is the loudest user-facing entry in the Vercel error table, 3 days to 2026-09-04:

| cluster | count | users | route |
|---|---:|---:|---|
| `[pack-detail] pack_lifecycle … read exceeded 5000ms` | **56** | **50** | `/[collection]/pack/dist/[distId]` |
| `[pack-detail] pack_realized_ev … read exceeded 5000ms` | 24 | 24 | same |

⭐ **Those lines are the bound WORKING**, not a crash: `lib/pack-dist/fetchers.ts` cuts the read at 5 s and the panel degrades honestly. 50 users saw a degraded lifecycle panel rather than a 504, which is the trade that module was written to make.

## 2. `pg_stat_statements`, window **23.5 days** (reset 2026-08-12 01:33:59Z)

| | value |
|---|---:|
| calls | **10,455** |
| mean | **3,129 ms** |
| max | **29,949 ms** |
| total | **9.1 hours** |
| blocks | 21.6 M |

⚠ **The maximum at 29,949 ms is the 30 s `statement_timeout`, not a coincidence** — those calls were killed.

## 3. ⛔ AND 9.1 HOURS IS NOT A COST FINDING — carry the denominator

Instance `total_exec_time` over the same window is **1,962 hours**. So `get_pack_lifecycle` is **0.46%** of instance DB time.

That is the same shape the 2026-09-03 sniper-feed filing reached (0.67%), and the same rule applies: **rank by absolute inflation, and an expensive-looking function is not a cost until you have named the caller.** ⛔ **Do not sell any change here as a cost saving.**

## 4. 🚨 THE PART THAT SETTLES IT: warm, the function's heaviest leg is 23 BUFFERS

`EXPLAIN (ANALYZE, BUFFERS)` on the pulls leg (the `pack_rips → moment_acquisitions → moments → editions` chain plus the per-pull `fmv_snapshots` LATERAL), a real 5-pull pack, run **twice**:

| run | buffers | of which PHYSICAL READS | execution | planning |
|---|---:|---:|---:|---:|
| 1 | 23 | 14 | 9.8 ms | 45.8 ms |
| 2 (warm) | 23 | **13** | 33.4 ms | 28.5 ms |

The dist-resolution leg (the 4-table join with the `GROUP BY`) is **13 buffers / 14.9 ms**. Every join is an index scan; the partitioned `fmv_snapshots` LATERAL is three index-ONLY scans with `Heap Fetches: 0`.

**Two things follow, and the second is the finding:**

1. **Planning is comparable to or larger than execution** on every leg (28–86 ms planning against 10–33 ms execution), because the function issues ~8 separate queries and `fmv_snapshots` is partitioned. That is real but it is tens of milliseconds.
2. ⭐ **13 of 23 buffers were still PHYSICAL READS on the SECOND consecutive run of the same query.** A 23-buffer working set that will not stay in cache is the **disk-IO saturation signature on the SMALL (2 GB) instance**, which CLAUDE.md already names as ONE root cause behind the fmv-recalc kills, `public_board_slow_count`, the board-warm failures and the pg_cron statement timeouts.

**A 23-buffer read cannot take 3,129 ms because of its plan.** The mean is the instance's IO budget, not this function's shape.

## 5. What NOT to do

- ⛔ **Do not add an index.** Every leg already uses one, and the planner is choosing index-only scans with zero heap fetches. There is nothing for an index to fix.
- ⛔ **Do not rewrite the function.** A rewrite would be measured against a warm baseline of ~25 ms and would look like a win for reasons that have nothing to do with the change — the "a DB A/B must be WARM-vs-WARM" trap, on an instance where warm is not reliably warm.
- ⛔ **Do not raise the 5 s bound.** It is the only reason 50 users got a degraded panel instead of a 45 s wall.
- ⛔ **Do not re-file this as a saturation investigation.** CLAUDE.md's standing steer is explicit: the fmv-recalc kill rate, `public_board_slow_count`, the board-warm failures and the pg_cron timeouts are one root cause, and the lever is **cutting work — page size, precompute, fan-out — never raising a timeout and never upgrading the tier.**

## 6. What WOULD be actionable, stated so the next session does not have to re-derive it

**Precompute, not tuning.** The lifecycle payload for a ripped pack is immutable once the rip is indexed — ownership chain, rip event, pulls and their edition metadata do not change. Only `current_fmv` per pull moves. So the shape that fits the standing steer is a materialised lifecycle keyed by `pack_nft_id` with FMV joined at read time, which turns ~8 planned queries and a cold 23-buffer chain into one indexed row.

⚠ **Not costed, and it needs the caller census first:** `get_pack_lifecycle` has 10,455 calls in 23.5 days (≈445/day) across an unknown number of distinct packs. **If the working set is small the MV is cheap; if it is the long tail it is a write amplification.** That census is one query and it is the thing to do before anything else.

## Falsifiers

- §4: re-run the two `EXPLAIN (ANALYZE, BUFFERS)` legs in a genuinely quiet window. **If the second run comes back with `read=0`, the working set DOES stay cached and the IO-saturation attribution is wrong** — at which case the 3,129 ms mean needs a different explanation and this filing is superseded.
- §3: `select round((sum(total_exec_time)/1000/3600)::numeric,1) from pg_stat_statements` — a materially smaller instance total would raise the 0.46% share and could make this a cost finding after all.
- §6: `select count(distinct p_pack_nft_id)` is not available from `pg_stat_statements` (the parameter is folded into one queryid). The census has to come from route logs or from `pack_rips` reachability, and **that limitation is why §6 is a proposal and not a plan.**
