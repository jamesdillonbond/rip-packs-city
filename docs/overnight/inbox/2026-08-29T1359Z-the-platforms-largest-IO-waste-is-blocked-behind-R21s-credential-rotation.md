# The platform's largest single addressable IO waste is blocked behind **R21's credential rotation** — and nobody had drawn the line

**Filed 2026-08-29 (PT) by Claude Code, autonomous pass.** No new measurement was needed for the last step of this; the pieces were in three documents that had never been put next to each other.

## The chain

1. **Ranked the whole instance by cold reads** (`pg_stat_statements`, ordered by `shared_blks_read`) looking for the next optimisation target after this session's five.
2. Two entries stand out for being **table reads, not functions**: `topshot_pack_sales_history` (**63.9M cold blocks, 3.6% of all instance cold reads**, 3,311 calls, **19,306 cold reads/call**, mean 8,062 ms) and `allday_pack_sales_history` (**58.2M, 3.2%**, 3,510 calls, 16,587/call, mean 8,234 ms). **Together 6.8%.**
3. The query text is the giveaway — no `WHERE` at all, and an exact count:
   ```sql
   WITH pgrst_source AS (SELECT * FROM topshot_pack_sales_history LIMIT $1 OFFSET $2),
        pgrst_source_count AS (SELECT $3 FROM topshot_pack_sales_history)   -- full scan, every call
   SELECT (SELECT count(*) FROM pgrst_source_count) AS total_result_set, …
   ```
   That is PostgREST's `count=exact` on a **305 MB / 587,625-row** table (AllDay: 281 MB / 552,427). ~40,000 blocks touched per call ≈ **the whole table, every call**. Role is `service_role`, so it is a server-side caller.
4. **Not in the repo.** A whole-tree grep for `pack_sales_history` finds only `lib/pack-dist/fetchers.ts`, which calls the *RPC* `get_pack_sales_history` — not the tables.

## ⛔ It is already filed, and I nearly re-filed it

[inbox 2026-08-22T1956Z](2026-08-22T1956Z-the-saturation-is-structural-a-waste-ledger-from-pg-stat-statements.md) found this a week ago, sized it at **529 GB / 6.4% of all reads**, and recorded the VACUUM fix as **refuted** (the visibility map is re-dirtied by the indexers' own upsert traffic; `allday` was 10 of 18,109 pages all-visible). ⭐ **Checking before filing is the only reason this is an update rather than a duplicate.** ✅ **Re-measured today: still live, 6.4% → 6.8% a week later.**

## ⭐ THE NEW PART: the stated blocker is stale, and the real one is already in someone's queue

That filing's blocker reads: *"The two edge functions have **NO SOURCE IN THE REPO** (deploy-only) … Needs an operator with the real source, not an agent session."*

**That is no longer the right description.** On 2026-08-28 the R21 pass fetched every deploy-only edge source and staged 18 of them in `docs/audits/edge-fleet-staging-2026-08-28/`. The pack-sales indexers are **not** among the 18 — and R21's own census says exactly why:

> 🚨 **THE OTHER 11 CARRY HARDCODED CREDENTIALS IN THE DEPLOYED BUILDS and were deliberately NOT committed** (committing would publish the keys): **(a) 5 × unrotated `rpc_pls_` gate literals … backfill-allday-dist-opened, **backfill-allday-pack-sales**, **backfill-topshot-pack-sales**, resolve-allday-pack-dist, resolve-allday-pull-editions** — ⚠ three of these are ACTIVELY INVOKED 350–460×/day, so those literals are live production auth

**So the chain terminates somewhere concrete:**

> 6.8% of instance cold reads → two unfiltered `count=exact` reads → two edge functions whose source cannot be committed → **because they carry unrotated hardcoded gate keys** → R21, owner "rotation of the 11 → Trevor (secrets) + Claude Code".

⭐ **This changes R21's priority, not its content.** It has been carried as a security-hygiene item. It is *also* the gate on the platform's largest single addressable IO cost, on an instance whose binding constraint is disk IO and which spent this session's whole daytime band at 30-of-36 backends in IO wait. **Two of the five keys to rotate unblock a ~6.8% read reduction.**

## 👉 What follows once the rotation lands

- The fix itself is expected to be small: PostgREST `count=exact` → `count: 'planned'` / `head`, or drop the count entirely. ⛔ **Expected, not verified — nobody has read these two sources.**
- ⚠ **There is a correctness item riding along, from the same 08-22 filing:** those queries are `SELECT * … LIMIT/OFFSET` with **no `ORDER BY`**, which is this repo's documented unstable-pagination ban (a `.range()` without a deterministic `.order()` reads the right *number* of rows and the wrong *rows*, and the duplicates and omissions cancel so every count-based check passes). **Fix both in the same pass, or the cheaper one will be taken and the silent one left.**

## ⛔ Not established

- **That `count=exact` is removable without breaking a caller.** Something may be reading `total_result_set` to drive its paging loop. **Read the source first** — that is the whole point of unblocking it.
- **Which of the two costs more per unit of useful work.** They were ranked by total cold reads, not by rows ingested.
- ⚠ **`pg_stat_statements` has been EVICTING since 2026-08-22 (`dealloc` went 0 → 1)**, so every "% of all reads" here — mine and the original's — is a **lower bound over an incomplete population**. Re-check `dealloc` before quoting either figure.
- ⚠ **Cumulative-since-reset, not a rate.** These totals span the stats window, not a day; do not read "6.8%" as "6.8% of today".
