# Handoff — 2026-07-29 (round 2) · a daily job that times out every night

## ✅ RESOLVED 2026-07-29 (Claude Code) — item 19 fixed; the diagnosis below was wrong, and a larger defect was found next to it

Read this before the original text. Ledger entry (2026-07-29) carries both revert paths.

- **The timing-out statement was step 1d `seed_topshot_collision_knot_targets`, not the detector.** `pipeline_runs.extra` names it directly (`seed_knot_error` on all 3 retained runs), and step 5's `refresh_topshot_conflated_editions_detector_only` **succeeded every night** — it returned `conflated_editions_remaining` 810→803→792. The "no limit, no args ⇒ obvious suspect" reasoning was sound but the evidence was already in `extra` and contradicted it. **The boundedness table is the actual trap:** 1d is listed "bounded: yes" because it carries `LIMIT greatest(1, p_limit)`, but that LIMIT bounds *output*, not *work*.
- **Real cause:** X was an inline subquery, so the planner inverted the join, estimated the driving `editions ey` regexp filter at **159 rows (actual 12,986)**, and probed `moments` via `moments_edition_id_serial_number_key` with only `serial_number` bound — the *trailing* column, so a full index scan per outer row. >120s even at `LIMIT 5`. Fixed with `WITH x AS MATERIALIZED`: **timeout/0 rows → 1,048 ms/96 rows.** The step had never once succeeded.
- **The ⚠ frozen-window check was right, but on the wrong metric.** `knots_resolved: 5` is fine — 66 rows / 66 distinct `x_nft_id`, up from 51 = 3 nights × 5, so the identical 5 is just the `p_limit=5` cap. **`wmc_realigned: 5` IS a genuine infinite loop:** the same 4 nfts realigned 4 nights running, because a wallet-walk writer reverts `wmc.edition_key` afterwards (proven by contrast — the same nft on a cold wallet stayed fixed). Only 4 rows; queued as WMC-REALIGN-VS-WALLET-WALK-EDITION-KEY-LOOP, not fixed here (needs a wmc write-path change).
- **Larger find, fixed:** step 4 `remap_topshot_split_resolved_subeditions` had the 07-27 `nem_from_sales` defect — its `LIMIT` sampled 8,000 arbitrary rows from a **673,195-row** table that is ~99% already-split, so it reported `wmc_split` 0/1/2/night while **82,272** wmc rows sat ready to move. Predicate pushed into the candidate CTE; a bounded verification run moved 170 wmc + 11 sales + 45 moments in 4.7s. Nightly cron drains the rest (~10 nights).

## Context

Found while sweeping the alert-noise items left over from the 07-28 audit. One is real and unaddressed; the other two resolved themselves and are recorded here so nobody re-files them.

Nothing shipped from Cowork for this — it needs a function change and a judgement call about where the work belongs.

---

## 19. `drain-conflated-subeditions` times out on 100% of runs

**Pipeline:** `drain-conflated-subeditions`, daily at 20:30Z.

Every retained run has died the same way:

| run | ok | rows_found | rows_written | error |
|---|---|---|---|---|
| 2026-07-29 20:30Z | false | 0 | 0 | `canceling statement due to statement timeout` |
| 2026-07-28 20:30Z | false | 56 | 2 | same |
| 2026-07-27 20:30Z | false | 0 | 2 | same |

**It is not fully wedged** — partial work lands each night (`knots_resolved` 5, `wmc_realigned` 5, occasional `wmc_split`/`sales_split`/`moments_split`). It gets part way, hits the ceiling, and dies.

**The timeout is almost certainly the DETECTION pass, not the drain.** The queue tables are tiny — `topshot_conflated_editions` ~796 rows, `topshot_collision_knot_resolutions` ~51 — nothing there can take 30s. Meanwhile the function family splits cleanly by boundedness:

| function | bounded? |
|---|---|
| `seed_topshot_conflated_subedition_targets(p_max_editions)` | yes |
| `seed_topshot_collision_knot_targets(p_limit)` | yes |
| `resolve_topshot_subedition_collision_knots(p_limit)` | yes |
| **`refresh_topshot_conflated_editions()`** | **no limit, no args** |
| `refresh_topshot_conflated_editions_detector_only()` | no limit, no args |

The unbounded refresh is the obvious suspect: it has to scan the big tables (editions / `wallet_moments_cache` at ~1.58M / partitioned `sales`) to *find* conflations, and unlike every sibling it has no cap. Confirm with an `EXPLAIN (ANALYZE, BUFFERS)` on its body before changing anything — do not assume from the signature alone.

**Three fix shapes, in preference order:**

1. **Bound the detector.** Give `refresh_topshot_conflated_editions()` a limit/incremental predicate like its siblings, so a night's pass is finite. Cheapest and matches the existing house pattern.
2. **Split detection from drain.** Right now one timeout kills both, so the drain is punished for the detector's cost. Separate pipelines would let the drain finish even when detection is slow.
3. **Move it to a longer-timeout role** — last resort. Four `cron_heavy` jobs already exceed even the 600s ceiling and the 07-26 finding was explicit that raising ceilings is the wrong fix.

**⚠ One thing to check while you are in there.** `knots_resolved: 5` and `wmc_realigned: 5` are **byte-identical across all three runs**. That is either legitimately five new knots a night, or the same five reprocessed forever — the frozen-selection-window signature (measurement-lies #22, where a cursorless `ORDER BY … LIMIT` re-selected the same rows indefinitely and the yield stat described only the stuck window). Confirm the resolver advances rather than re-reading the same head. If it does not, the timeout is the smaller of the two bugs.

**Revert:** revert whatever function change lands; the pipeline's current state is "times out nightly," so there is nothing to restore beyond that.

---

## Not filed — these resolved themselves

Recorded so they are not re-raised from stale readings.

**`allday-unmapped-resolver` — recovered.** On 2026-07-28 it was failing **90 of 183 runs (49%)**, self-flagging `degraded` / `scan_ineffective`, and I was going to file it as manufactured alert noise. Over the last 24h it is **94 runs, 94 ok, 0% fail, 1,785 rows written**. The degraded condition cleared as the AllDay unmapped backlog drained. Filing it would have been wrong, and the only reason it wasn't is that the current state got re-measured instead of trusting the earlier number.

**`topshot-misattrib-drain` — cosmetic only, low frequency.** Still reports `ok=false` while doing its job: last run wrote **920 rows** and failed solely because some `GetMintedMoment` GQL sub-calls errored (`terminated_reason: targets_exhausted`). One run per 24h, and the drain is near exhaustion. Worth an `ok=true` + `partial_failures: n` shape if the file is ever open, not worth a trip on its own.

## Guardrails

Unchanged.

**Claude Code's direct file inspection wins over this doc on any disagreement.**

## Expected end state

`drain-conflated-subeditions` completes within its statement timeout — or is split so the drain is no longer killed by detection — and the resolver is confirmed to advance rather than reprocess the same five knots nightly.
