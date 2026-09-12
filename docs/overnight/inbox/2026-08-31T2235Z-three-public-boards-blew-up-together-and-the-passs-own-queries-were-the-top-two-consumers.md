> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-08-31T22:35Z — three public boards blew up together at 20:28Z, and the two biggest consumers in that window were the pass's own measurement queries

> ⚠ **SCOPE.** The push blocker is specific to **this cloud session** (no `mcp__remote-devices__*` tools
> were present at all — the "device-bound v2" task fired cloud-only again). Trevor's machine and Claude
> Code push normally via the PAT in `remote.origin.pushurl`. **Commit this file as usual.**

**Status:** OPEN. Nothing shipped — no lever was clearly-safe on this evidence.
**Read at:** `origin/main` 7c63fa3, cloned and fetched 22:18Z. DB `now()` taken in-query throughout.

---

## FINDING 1 — three unrelated public boards degraded simultaneously, and it looks like observer effect

`public_board_liveness_history`, all probes in the last 30 h (`elapsed_ms`):

| probe (UTC) | candy_scarcity_board | candy_player_board | allday_scarcity_board |
|---|---:|---:|---:|
| 08-30 20:28 | 2,208 | 1,187 | 1,054 |
| 08-31 00:28 | 698 | 648 | 1,502 |
| 08-31 06:28 | 4,890 | 527 | 1,333 |
| 08-31 11:28 | 841 | 860 | 1,205 |
| **08-31 20:28** | **34,239** | **19,738** | **13,532** |

Six boards were over their `max_ms` at 20:28Z (also `candy_secondary_board` 13,746, `pack_table_rows`
3,942, `topshot_2025_rookie_cohort_stats` 3,314). **`candy_scarcity_board` at 34.2 s is past the ~30 s
read-path wall** — during that window that public `/insights` board was failing for real users, and per
the skill's own warning this is invisible to 5xx metrics if the page serves `cache=STALE`.

⭐ **These boards share nothing but the instance.** Three different collections, three different views,
all 11–41× their own two-hours-earlier reading. That is the signature of instance-wide contention, not
of a per-board query defect — and it is consistent with known-issue #4's standing read of
`candy_scarcity_board` as CONTENTION-bound.

**What else was happening in that exact window.** pgss diff on `(userid, dbid, toplevel, queryid)`,
baseline 20:19:28.554Z → 21:00:41.302Z (41.2 min), ranked by buffers touched:

| # | buffers | calls | sec | what |
|---|---:|---:|---:|---|
| 1 | **18,808,020** | 1 | 82.9 | **an ad-hoc `audit_20260830_pgss_snap` self-diff — the previous pass's own instrument query** |
| 2 | **14,172,662** | 27 | 103.4 | **`public.query_sql(...)` — the MCP `execute_sql` agent channel** |
| 3 | 13,530,075 | 60 | 522.1 | the unattributed `fmv_snapshots` read (2110Z filing) |
| 4 | 3,832,527 | 112 | 680.5 | a production RPC |
| 5 | 1,951,680 | 2 | 11.8 | `explain (analyze, buffers …)` of the same pgss self-diff — agent again |

**#1, #2 and #5 are all the autonomous pass measuring the instance: ~34.9 M buffers, more than the
unattributed caller the 2110Z filing was written about.** The single most expensive statement on the
instance in that 41 minutes was a pass's own pgss diff: 18.8 M buffers, 82.9 s, one call.

⚠ **Attribution is CORRELATION, not proof.** I did not run a positive control (I cannot pause the
scheduled passes), and I cannot rule out that both the boards and the burst were downstream of a third
cause. What is measured and not in dispute: the boards degraded 11–41×, and the two largest consumers
in the window were the pass's own queries.

⚠ **The 18.8 M query ran on the WRONG SIDE of its own fix.** `pgss_snap_at_index` was applied at
20:25:52Z, inside this window — so that 18.8 M reading is the pre-index cost the 2020Z pass had already
diagnosed. This pass's diffs ran post-index and are in the cheaper bucket. The lesson survives anyway,
because of Finding 2.

---

## FINDING 2 — over a full day the agent channel is 32.6% of every buffer the instance touches

Same instrument, widest clean window: **08-30 21:06:49Z → 08-31 22:20:41Z (25.2 h)**. No counter reset
(zero negative call deltas across 4,883 rows).

| bucket | distinct queries | calls | buffers | share of buffers |
|---|---:|---:|---:|---:|
| everything else (all production, cron, pipelines) | 1,638 | 580,175 | 1,122,392,846 | 67.4% |
| `query_sql` (MCP `execute_sql`) | 3 | 1,285 | 513,257,222 | **30.8%** |
| raw `EXPLAIN` | 54 | 73 | 28,843,832 | 1.7% |

**542,101,054 of 1,664,493,900 buffers — 32.6% — from 0.23% of the calls.** ~399,000 buffers/call
against production's 1,934: **206×**. At 8 KB/buffer that is ~4.1 TB of buffer traffic in a day from
the measurement channel on a SMALL 2 GB instance whose entire diagnosed root cause (focus.md priority 3)
is disk-IO budget.

⭐ **This is the saturation programme's own mandate turned on itself.** Item 15 says the lever is
cutting work. The 2020Z pass found its instrument was the #2 consumer *in its own window* and indexed
it; this is the same finding one level up, at 24-hour scale, and it is the largest single line item on
the board. **I include this pass in the accusation** — the diffs above cost buffers too.

⛔ **I am NOT proposing a fix.** The obvious ones (throttling the agent role, capping `work_mem`,
scheduling the snapshot) each trade away the diagnostic capability that has produced most of the last
fortnight's wins, and the naming/lifecycle call on scheduling the snapshot is already queued for Trevor
under item 15. **This is a budget decision, not an engineering one.** What I would want decided:
how many buffers per day is the pass allowed to spend?

Cheap discipline that needs no decision, if someone is editing the skill anyway: prefer
`pg_class.reltuples` over `count(*)`; always bound exploratory reads with `LIMIT`; never `EXPLAIN
ANALYZE` a diff query when `EXPLAIN (GENERIC_PLAN)` answers the question (it answered one for free
below); take one snapshot per pass, not one per hypothesis.

---

## FINDING 3 — post-ship watch: the 15:11Z thin-sales-guard LATERAL rewrite WORKS, 7.6× on buffers

`apply_fmv_thin_sales_guard(p_mode)` (queryid 928083656580906774) was the **#1 production consumer over
25 h at 151.7 M buffers** — but that window straddles migration `20260831151141`, which replaced its
`DISTINCT ON` over the whole 1.35 M-row history with a per-edition LATERAL. Re-measured like-for-like,
both daytime, both on total buffers:

| window | hours | calls | buffers/call | ms/call |
|---|---:|---:|---:|---:|
| PRE 09:05 → 15:12 | 6.11 | 38 | 1,304,187 | 2,279 |
| POST 15:12 → 22:20 | 7.14 | 43 | **171,324** | **587** |

**7.6× fewer buffers per call, 3.9× faster, at an unchanged call rate** (6.2/h → 6.0/h, so this is not
traffic falling away). Extrapolated, that is ~24.8 M buffers/day instead of ~189 M.

⭐ Nobody had measured this. It was applied by a no-push session and repo-recovered by the concurrent
Claude Code session (a6b3c4a) — the *repo* half was verified, the *production effect* never was.
**Exit condition, from this post-fix measurement and not from a hoped-for order of magnitude: this
regresses if `bufs_per_call` exceeds 400,000 over any 4-hour daytime window.**

---

## FINDING 4 — `scan-ufc-wallet` deployed v39 has no FMV block at all; the repo thinks it does

Chasing the 2110Z filing's open question, I pulled the deployed source. The 2110Z pass verified
`enrich-ufc-wallet` v46 against the repo but **`scan-ufc-wallet` was never checked.**

Deployed `scan-ufc-wallet` is **version 39** and ends after the `wallet_moments_cache` upsert. The
repo's copy (`supabase/functions/scan-ufc-wallet/index.ts` lines 236–300) has a whole FMV block —
`editions` → `fmv_snapshots` → `wallet_moments_cache.fmv_usd` writeback with the $10 K outlier ceiling.
It also upserts on a different conflict target (`wallet_address,moment_id` deployed vs
`wallet_address,collection_id,moment_id` in the repo).

**So production does not write `fmv_usd` on a UFC wallet scan, and the repo says it does.** Two
consequences: it is refuted as a caller of the mystery query, and there is a real repo/prod drift.

⛔ **Do NOT deploy the repo version to close the drift.** It would *add* traffic of exactly the shape
under investigation in Finding 5, and the conflict-target change needs its own review. Decide the
direction first.

---

## FINDING 5 — the 2110Z `fmv_snapshots` filing: three more hypotheses killed, caller still unknown

Do not re-run these.

1. ⛔ **Generic-plan hypothesis REFUTED.** I expected PostgREST's prepared statement to cache a generic
   plan that grabs `idx_fmv_snapshots_2026_computed_at_desc` and back-scans the whole partition —
   which would have explained a caller-independent 83× blowup. `EXPLAIN (GENERIC_PLAN)` (free, no
   execution) shows the generic plan uses `fmv_snapshots_2026_edition_id_timezone_idx` with
   `Index Cond: (edition_id = ANY ($1))`, est. 722 rows. **The plan is fine either way.**
2. ⛔ **`scan-ufc-wallet` REFUTED** structurally — see Finding 4, the deployed function cannot issue it.
3. ✅ **The 2110Z row math independently re-derived and CONFIRMED:** 518 UFC editions hold 4,391
   snapshot rows. `enrich-ufc-wallet` loads *all* UFC editions and chunks at 200 → exactly 3 calls per
   invocation, and cannot be the cost.

⭐ **What is new, and it changes how to read the 2110Z table: the per-call cost is a MEAN OVER A
MIXTURE, not a uniform per-call price.** Lifetime pgss for queryid 1387451210050502049:
`min_exec_time` **3.4 ms**, `mean` 3,749 ms, `stddev` **6,239 ms**, `max` 29,992 ms (the service_role
30 s timeout). **A stddev 1.66× the mean is a long tail, not a distribution around 225,501
buffers/call.** So the UFC functions are almost certainly the 3.4 ms floor, and a small number of rare,
catastrophic calls carry the buffers.

👉 **Next action, revised:** stop looking for a caller that issues this shape 60 times an hour. Look for
one that issues it *rarely, with a very large array*. The 20:19–21:00Z burst was 60 calls after **5.5
hours of exactly zero** (15:12→20:19: 0, 0, 0, 0, 0) — bursty, not periodic, which argues against a
cron and for something event- or human-triggered. Candidates still unchecked: cron-job.org entries
pointed at non-Vercel hosts, Cowork dashboard artifacts that re-query on open, and ad-hoc scripts
holding the service key. `.github/workflows` contains no reference to `fmv_snapshots` (checked).

---

## CORRECTION — do not delete the superseded task; BOTH scheduled tasks are unbound

This pass's own prompt says the old task `trig_01AZzLzkTPp5xbSjK1EFmeCw` "should be deleted now that
this one is approved and bound."

**Measured: it still exists and is enabled — and the premise is false.** This firing was
`trig_018AyNcnbCZuYb1Ztts6rbBR` ("device-bound v2, folder-attached") and **no `mcp__remote-devices__*`
tool was present in the session at all.** The replacement reproduced the exact defect it was created to
fix — the same thing the 1635Z pass recorded. Deleting the old task on a false premise would leave
Trevor with one task that also cannot push.

⛔ **Neither task was touched.** Both remain enabled. This needs Trevor: re-create the pass from the
Claude desktop app **on the machine**, then delete both.
