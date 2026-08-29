# My own falsifier fired: after the build fix, `refresh_wmc_fmv_drift_active` still reads ~1.8M `wallet_moments_cache` rows per pass to serve **26 wallets**

**Filed 2026-08-28 (PT) by Claude Code, autonomous pass.** Follow-on to `20260829023000_audit_20260828_rwfd_temp_build_materialized_cte`, shipped ~40 minutes earlier tonight. That migration stated a falsifier:

> *"if the lag does not close, the DRAIN — not the build — is the bottleneck, and the next lever is `v_chunk = 25` / the 15 s budget, neither of which this touches."*

⭐ **It fired. This filing is the drain measurement, and the answer is neither of the two levers I guessed.**

---

## What the build fix did and did not do

The build fix was real and is holding: **9 post-fix runs, 0 failed** (pre-fix rate 17.0%, 48/283 in 24 h), and the cutoff moved fast at first — `858.7 → 766.7 → 556.9` minutes of lag between 01:47Z and 02:05Z, roughly **5h20m of backlog cleared in 18 minutes**.

⛔ **Then it stopped.** Between 02:05Z and 02:34Z — 29 minutes of wall clock, ~6 runs — the cutoff advanced **16 seconds**. It has since crept to 17:08:42Z. **Backlog editions: 12,320 at baseline → 13,193 now. It is going backwards.**

⚠ **The lag-in-minutes was the wrong instrument for the second half.** The early sprint was through a sparse region of the snapshot timeline; the wall is a dense one. **Editions drained per run is the load-independent number; minutes-of-lag is not**, and reading only the minutes would have called this fixed at 02:05Z.

## The drain, measured

`v_chunk = 25` editions per iteration. Reproduced one iteration's row-identification half as a read-only `SELECT` against a real 25-edition slice of the live backlog, `ANALYZE + BUFFERS`:

```
Hash Join (actual time=1064.711..1064.714 rows=0 loops=1)
  Buffers: shared hit=1169 read=2073 dirtied=10
  ->  Nested Loop  Rows Removed by Join Filter: 3406
        ->  Index Scan using idx_wmc_coll_ek_serial_cover
              (actual time=1.776..42.341 rows=136 loops=25)
```

**1,065 ms and 3,242 buffers for ONE chunk, returning ZERO rows.** Every changed edition is held by ~**136** wallets on average, so the plan reads **3,406 `wallet_moments_cache` rows per 25 editions** and discards all of them. The 3,242 buffers for 3,406 rows is ~1 page per row — **pure heap fetching**: `idx_wmc_coll_ek_serial_cover` is `(collection_id, edition_key, serial_number) INCLUDE (moment_id)`, so neither `wallet_address` nor `fmv_usd` is in the index and every candidate row must be visited to evaluate either filter.

At ~1 s per chunk inside a 15 s budget that is **~14 iterations ≈ 350 editions per run**, against a backlog of 13,193 that grows faster than that.

🚨 **Scaled to the backlog: ~1.8 million `wallet_moments_cache` row reads per full pass.**

## The number that makes it absurd

| | |
|---|---|
| active `allow_list` wallets | **26** |
| `wallet_moments_cache` rows those 26 wallets hold | **202,177** |
| `wallet_moments_cache` rows in total | **2,496,749** |
| share of the table this function can EVER update | **8.1%** |

⭐ **The function reads ~1.8M rows across the whole table to maintain 202k rows belonging to 26 wallets, and its successful runs write `rows_written` of 0, 0, 0, 1, 2.** The chunking is what forces this plan: driven 25 editions at a time, the only usable access path is edition-first, and edition-first costs ~136 rows per edition **whatever the chunk size**. ⛔ **So `v_chunk` is NOT the lever — the per-edition cost is linear in editions, and raising or lowering 25 changes only per-iteration overhead.** My own migration named the wrong next step.

## The asymmetry that is the actual finding

⭐ **The two access paths have completely different cost SHAPES, and the chunking picks the wrong one:**

- **edition-first** (today): ~136 rows × N changed editions → **1.8M rows** for the full backlog.
- **wallet-first**: 26 wallets → their 202k rows, **fixed cost regardless of how many editions changed** → **9× cheaper across a full pass.**

**The chunked loop cannot take the wallet-first path**, because at 25 editions per iteration the fixed 202k-row cost would be paid 528 times.

⚠ **But wallet-first is NOT free and I measured that too, in the direction that hurts my own proposal:** materialising the 202,177 allow-listed rows (`WHERE wallet_address IN (26) AND edition_key IS NOT NULL`) **exceeded 60 s and could not be EXPLAIN ANALYZEd** — because `idx_wmc_cohort_cover` is `(wallet_address, collection_id) INCLUDE (fmv_usd)` and carries no `edition_key`, so that path is 202k random heap fetches too. **Neither side has a covering index. That is the root cause, not the loop.**

## The candidate fix — a REPLACE, not an ADD

`idx_wmc_cohort_cover (wallet_address, collection_id) INCLUDE (fmv_usd)` → **`(wallet_address, collection_id, edition_key) INCLUDE (fmv_usd)`**.

- ⭐ **Leading columns are unchanged, so every current use of the index survives** — this is an extension, not a new access path.
- It makes the wallet-first plan **index-only** for exactly the columns this function needs (`wallet_address`, `collection_id`, `edition_key`, `fmv_usd`).
- Size is roughly a wash: one key column added, nothing removed.

⚠ **`idx_wmc_cohort_cover` is 604 MB — the LARGEST index on the table — for 8,723 scans.** That is a low-value index worth its own look (it interacts with the 289-unused-indexes filing, which ranked by write cost and would not surface this one because it is *used*, just barely). ⛔ **8,723 is not zero: do not read this as "drop it".**

## ⛔ NOT SHIPPED, and the reasons are not doubt about the measurement

1. **`wallet_moments_cache` is the hottest table on the instance** (2.5M rows, constant `upsert_wmc_batch` traffic from the backfill waves) and already carries **~1.99 GB of indexes**. A non-concurrent `CREATE INDEX` blocks writes for the build.
2. `CREATE INDEX CONCURRENTLY` is reachable here **only via the one-statement pg_cron recipe**, so this is a multi-step change (create concurrently → verify → drop the old → verify) on the hottest table, at 19:40 PT, on one session's analysis.
3. **The loop rewrite that would exploit it is a separate change with its own risk** — dropping the chunking loses the resumability two prior migrations (`20260812232940`, `20260813142301`) added *because this function kept dying*. Reintroducing an unbounded statement under a 30 s `service_role` timeout is how it got chunked in the first place.

👉 **Sequence, if taken up:** index first, alone, and re-measure the wallet-first `SELECT` — **if it does not come back index-only, stop; the loop rewrite has no basis without it.** Only then consider the loop.

## ⛔ Not established

- **Whether `refresh_wmc_fmv_drift_active` is worth fixing at all.** Its predicate (`>25%` deviation, allow-listed wallets) is a strict SUBSET of `refresh_wmc_fmv_changed`'s (`IS DISTINCT FROM`, all wallets), which writes ~622 rows/run against drift's ~1. **On paper drift is a prioritisation backstop for the 26 active wallets while `changed` works through its own backlog — but nobody has measured whether it ever updates a row `changed` would not have reached first.** ⚠ That question decides between "add an index" and "retire the job", and it is cheap to answer: instrument which rows drift updates that `changed` had not already converged. ⛔ **Do NOT retire it on `rows_written` — CLAUDE.md names that exact error.**
- **Whether 136 holders/edition is representative.** One 25-edition sample from the head of the backlog.
- **Whether the replacement index is actually chosen by the planner.** An index existing is not an index used — tonight's `rwfd` fix turned on precisely that distinction, where the right index already existed and was unreachable.
