# RPC — candidate filing (CORRECTED): jobid 506 is structurally over budget — and its staleness reaches ONE INTERNAL INSTRUMENT, not the headline KPI I first claimed

> ⚠ **Self-correction (see §5).** The first push of this file claimed the stale cache under-reports the roadmap headline KPI by ~6 points. **It does not** — nothing user-facing reads the table. The cost measurements in §1–§4 are unaffected. ⚠ **The filename still carries the retracted claim**; it is kept because `docs/overnight/inbox/` is append-only and filings are permanent citation targets.

**Run:** 2026-09-19 4:24 PM PT (23:24Z) · Claude Code, Windows box · **READ-ONLY, nothing shipped.** · quiet window (io_wait 0 / active 1 / 17 conns), which is what made the measurement possible
**Follows:** `2026-09-19T2106Z.md` — specifically its **Candidate 2**. ⚠ That file has since been CORRECTED by its own author: the `trust_precompute_max_age_hours` breach it originally pinned on 506 is written by **jobid 324** (`rpc-thp-leg-impossible-parallel`), not by 506. **This filing is about jobid 506 only**, which that correction keeps as a real but separate, smaller issue. It measures it and **kills the obvious fix**.

## 1 — Where the 120 s goes: ONE of the five arms is 85% of the budget

`refresh_fmv_confidence_precompute()` (jobid **506**, `35 1,5,9,13` UTC, runs as **`postgres`**) loops five collections. Its own `duration_ms` column, from the last SUCCESSFUL run (09-18 22:36 PT), settles the apportionment without any new instrument:

| arm | duration_ms |
|---|---|
| **nba_top_shot** | **100,826** |
| nfl_all_day | 16,675 |
| laliga_golazos | 561 |
| ufc_strike | 238 |
| disney_pinnacle | 5 |

⇒ **100.8 s of 120 s is Top Shot alone**; the other four total 17.5 s. That run finished at 118.4 s — the "success right at the edge" the 2106Z filing flagged. **There is no general slowness to fix; there is one arm.**

⚠ **The budget is the INSTANCE default, not a role setting.** `postgres` has **no** `statement_timeout` in `pg_roles.rolconfig` or `pg_db_role_setting` (only a `search_path`), so 506 inherits the cluster's 120 s. For contrast `cron_heavy` carries **600 s**. ⛔ Do NOT read that as "just move 506 to `cron_heavy`" — see §4.

## 2 — The mechanism: 78:1 read amplification that GROWS DAILY

`sentinel_fmv_confidence_rows(cid)` is `SELECT DISTINCT ON (edition_id) confidence … WHERE collection_id = $1 ORDER BY edition_id, computed_at DESC`. Measured (`EXPLAIN ANALYZE, BUFFERS`, Top Shot):

> `Merge Append (actual rows=1,095,052)` → `Unique (actual rows=14,016)`

**It streams 1,095,052 snapshot rows to produce 14,016 answers.** The index is fine and is not the problem: `idx_fmv_snapshots_collection_edition (collection_id, edition_id, computed_at DESC)` is **attached and `indisvalid` on all 3 partitions** (2025/2026/2027) and the plan uses a covering Index Only Scan. ⚠ **The cost is the DEFINITION, not the plan** — every snapshot ever written for an edition is read and discarded. **That ratio rises every day the FMV writer runs**, so this job is on a deterministic path to permanent failure, not suffering an IO flake.

📏 **And it can never be warm on this box.** Two consecutive runs, second immediately after the first: `hit=50,435 read=16,276` then `hit=50,506 read=**13,247**`. **The physical reads barely fall**, because the working set (~64k buffers ≈ 512 MB of index) does not fit a SMALL tier's cache. ⇒ **IO-bound by CLAUDE.md's own warm/cold diagnostic, and no index helps.**

## 3 — ⛔ THE OBVIOUS FIX IS ALREADY FORBIDDEN, IN WRITING

The natural move is R50's recipe: read `edition_fmv_current` (latest-FMV-per-edition, 21,424 rows, 13 MB) instead of DISTINCT ON over the partition set. **That table's own `col_description` forbids it:**

> *"⛔ DO NOT POINT MORE BOARDS AT THIS TABLE UNTIL THAT IS FIXED"* — its incremental refresh cannot see a correction that does not advance `computed_at`, and **162 of 14,016 Top Shot editions (1.16%) currently publish a value their own source contradicts, skewed HIGH** (net +$46,060 overstated).

⭐ **Reading the column comment BEFORE building on the table is what saved this** — the cost case for the swap is excellent and it would have imported a live pricing defect. `v_topshot_parallel_premiums` was refused the same swap on 09-18 for the same reason.

## 4 — A candidate that WORKS but is NOT a free win: loose index scan

A skip-scan (recursive walk of distinct `edition_id`, then one `ORDER BY computed_at DESC LIMIT 1` per edition) is **exactly equivalent** — both computations run in ONE statement, same instant, same instrument, `FULL OUTER JOIN` on confidence:

| confidence | current DISTINCT ON | loose index scan | delta |
|---|---|---|---|
| ASK_ONLY | 2453 | 2453 | **0** |
| HIGH | 1341 | 1341 | **0** |
| LOW | 3591 | 3591 | **0** |
| MEDIUM | 6024 | 6024 | **0** |
| NO_DATA | 326 | 326 | **0** |
| SALES_ONLY | 5 | 5 | **0** |
| STALE | 276 | 276 | **0** |

⚠ **But the cost comparison is a TRADE, and the naive read of it is backwards.** Buffers, warm-vs-warm:

| | total buffers | **physical reads** | exec |
|---|---|---|---|
| DISTINCT ON (current) | 63,753 | **13,247** | 2,010 ms |
| loose index scan | **216,403** | **0** | 318 ms |

⛔ **On BUFFERS — the metric CLAUDE.md says to compare — the candidate is 3.4× WORSE.** It wins only because its 216k buffer touches are all *hits* against a tiny working set, while the incumbent's smaller total includes 13k *physical reads* it must pay on every single run. **On an IO-bound instance the reads are the cost and the hits are cheap CPU — but that is a reasoned trade, not a measured win, and quoting "18× faster" would be quoting a timing.**

👉 **STILL OWED BEFORE THIS SHIPS:** a **cold-start control** for the candidate. Its 0 reads were measured immediately after a full scan had warmed the cache; the claim that its working set *stays* resident has NOT been demonstrated from cold. ⚠ It also multiplies per-edition round trips, so it degrades differently under concurrency than the incumbent does.

## 5 — 🔁 RETRACTED: the staleness reaches ONE INTERNAL INSTRUMENT, not the roadmap's headline KPI

⛔ **An earlier version of this filing (pushed as `90f69a92e`) claimed the stale cache "under-reports the roadmap's headline metric by ~6.0 points". THAT WAS WRONG, and it was wrong in the way this repo names most often: I published a CONSEQUENCE without establishing the CALLER.**

📏 **What the measurement actually shows still stands** — `fmv_confidence_precompute` has not refreshed since **09-18 22:36 PT**, and cached-vs-live Top Shot, same query, same instant:

| | HIGH | MEDIUM | HIGH+MED of 14,016 |
|---|---|---|---|
| cached | 1313 | 5208 | 6,521 = **46.5%** |
| live now | 1341 | 6024 | 7,365 = **52.5%** |

⛔ **What does NOT follow is who reads it.** A repo grep finds the table in **docs only — no code path reads it** — and the DB agrees: the complete set of referencing objects is **two functions**, `refresh_fmv_confidence_precompute()` (its only writer) and **`rpc_ops_snapshot()`**. ⇒ **No user-facing surface reads this table, and the roadmap KPI does not come from it** (`fmv_high_med_share_pct` in `metrics-latest.json` is computed live by the nightly pass). **The blast radius is one internal ops-health field.**

⚠ **So the severity drops: this is an INSTRUMENT-freshness defect, not a user-facing price or KPI defect** — the same class the corrected `2026-09-19T2106Z.md` assigns to its own Candidate 1, and for the same reason. ⭐ **It is still worth fixing**, because `rpc_ops_snapshot()` is what a monitor reads to decide whether the estate is healthy, and an 18 h-old confidence distribution there is a watcher reporting yesterday — but it does **not** justify emergency handling, and nothing a user sees is affected.

⭐ **The lesson, which is the durable part:** the cost measurements in §1–§4 were direct and survive intact; the *consequence* sentence was inherited from the framing of the filing I was following up, and I did not re-derive it. **`grep` the repo AND the DB for readers before stating what a stale cache costs** — here the two disagreed with my assumption in the same direction, and the whole claim rested on it.

## 6 — Suggested action (SUPERVISED; ⛔ not auto-shippable)

- **Do NOT** point this at `edition_fmv_current` (§3).
- **Do NOT** simply move 506 to `cron_heavy`/600 s: it treats the symptom, holds a worker slot up to 10 min, and the estate already runs **32 concurrent pg_cron jobs against 6 worker slots** (filing `2026-09-19T…-pg-cron-32-concurrent`). It also lets the amplification keep growing silently.
- **Preferred:** rewrite `sentinel_fmv_confidence_rows` to the §4 skip-scan **after** the cold-start control, or give the precompute a per-collection watermark so Top Shot is not recomputed from all history every 4 h.
- ⚠ **Whatever ships, the arm to watch is Top Shot's `duration_ms`, not the function's total** — the total hides which arm moved.

**Not-candidates (recorded so they are not re-raised):** `disney_pinnacle` counts `{}` with `duration_ms: 5` is **not** an error — Pinnacle FMV is keyed on the (`character_name`,`set_name`,`variant_type`) triple and has no `fmv_snapshots` rows under this collection_id; it is a genuine absence, though ⚠ `coalesce(…, '{}')` means a real read failure would be indistinguishable from it, which is worth its own look. `detect_stalled_pipelines()` read **[]** at 23:20Z — no stalled pipelines estate-wide.
