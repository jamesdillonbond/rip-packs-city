# RPC — candidate filing (CORRECTED): jobid 506 is structurally over budget — and its staleness reaches ONE INTERNAL INSTRUMENT, not the headline KPI I first claimed

> ⚠ **TWO self-corrections, both against my own first push.** (1) **§5** — it claimed the stale cache under-reports the roadmap headline KPI by ~6 points. **It does not**; nothing user-facing reads the table. (2) **§4** — the loose-index-scan candidate it proposed is **WITHDRAWN**, having failed the very cold-start control that version said it still owed. **§1–§3 are direct measurements and are unaffected; what survives is a well-measured problem and NO accepted fix.** ⚠ **The filename still carries the retracted claim**; it is kept because `docs/overnight/inbox/` is append-only and filings are permanent citation targets.

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

👉 **COLD-START CONTROL RUN 2026-09-19 16:4x PT — ⛔ THE CANDIDATE FAILS IT. I am withdrawing it.**

The 0 reads above were measured immediately after a full scan had warmed the cache. Re-measured on **`nfl_all_day`**, a collection untouched all session (same shape: 6,189 editions from 471,075 snapshots, 76:1), running the **candidate FIRST while genuinely cold** and the incumbent second — an order that **favours the incumbent's cache state and still flatters the candidate's**:

| on `nfl_all_day` | total buffers | physical reads | exec |
|---|---|---|---|
| **loose index scan (COLD, ran first)** | **92,498** | **9,913** | 3,246 ms |
| DISTINCT ON (ran second, partly warm) | **29,018** | **5,791** | 3,307 ms |

⛔ **Cold, the candidate reads MORE (9,913 vs 5,791), touches 3.2× more buffers, and is not faster (3.25 s vs 3.31 s).** Its whole case was that its working set stays resident; **from cold it does not.**

⭐ **And the decisive number is ORDER-INDEPENDENT, which is why this is a conclusion and not another confounded reading.** Buffer *touches* are the same pages whichever runs first — cache state moves the hit/read split, never the total. That total is **3.2× worse on NFL (92,498 vs 29,018) and 3.4× worse on Top Shot (216,403 vs 63,753)** — the same ratio on both collections, measured in opposite cache states. **The incumbent does strictly less work; it just pays for more of it in physical IO.**

⚠ **CLAUDE.md's "compare BUFFERS, never timings" called this correctly from the first measurement and I nearly talked myself past it** on an 18× timing that was pure cache. The rule earned its place again.

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

## 6 — Suggested action (SUPERVISED; ⛔ nothing here is auto-shippable)

- ⛔ **Do NOT** point this at `edition_fmv_current` (§3) — unchanged, that remains forbidden in writing.
- ⛔ **Do NOT** ship the loose index scan (§4) — **withdrawn on its own cold-start control.**
- 🔁 **CORRECTION to this filing's first version: my objection to `cron_heavy` was overstated.** I wrote that it "holds a worker slot up to 10 min". ⚠ **But a FAILING run already holds that slot for the full 120 s and produces nothing** — the job's duration is what it is (~118 s when healthy), and raising the ceiling converts a guillotined failure into a completed run rather than lengthening a healthy one. The real residual risk is narrower and should be stated as such: **under an IO spell the run could stretch toward 600 s**, on an estate already scheduling 32 concurrent pg_cron jobs against 6 worker slots.
- 🚨 **AND IT HAS A PRECONDITION THAT FAILS AS SILENCE — verified, do not skip it.** `has_function_privilege('cron_heavy', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE')` is **FALSE**, as is EXECUTE on the inner `sentinel_fmv_confidence_rows(uuid)`. **SECURITY DEFINER is what the function RUNS AS, not who may CALL it.** Moving jobid 506 to `cron_heavy` without a `GRANT EXECUTE` **in the same migration** produces a job that keeps getting dispatched, shows the failure only in `cron.job_run_details`, and **never writes a `pipeline_runs` row** — i.e. it looks like the lane simply stopped. This is the documented orphaned-caller trap; it is one line to avoid and invisible to hit.
- ⭐ **The structurally right fix remains the one nobody has costed: stop recomputing Top Shot from all history every 4 h.** A per-collection watermark, or splitting the Top Shot arm onto its own schedule so one 100.8 s arm is not sharing a 120 s budget with four arms worth 17.5 s. ⚠ Splitting needs a parameterised entry point — the function takes no arguments and loops all five internally.
- ⚠ **Whatever ships, watch Top Shot's `duration_ms`, not the function total** — the total hides which arm moved.

**Not-candidates (recorded so they are not re-raised):** `disney_pinnacle` counts `{}` with `duration_ms: 5` is **not** an error — Pinnacle FMV is keyed on the (`character_name`,`set_name`,`variant_type`) triple and has no `fmv_snapshots` rows under this collection_id; it is a genuine absence, though ⚠ `coalesce(…, '{}')` means a real read failure would be indistinguishable from it, which is worth its own look. `detect_stalled_pipelines()` read **[]** at 23:20Z — no stalled pipelines estate-wide.

## Drained 2026-09-22 — RESOLVED — the precompute reads `edition_fmv_current` with a 1/64 drift sample (migrations `20260920054402` + follow-up); last four ticks succeeded, Top Shot arm 20 ms.

*(Per-item drained marker, the mechanism `docs/reference/autonomous-tasks.md` names as the unblock for archival. Re-derived live by the 2026-09-22 daytime Cowork pass; archiving remains Trevor's call.)*
