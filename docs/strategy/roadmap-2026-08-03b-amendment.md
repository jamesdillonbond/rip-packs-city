> ## Status update — 2026-08-03, later the same evening (Claude Code)
> **Item 0 (unstick the FMV sweep) is SHIPPED and VERIFIED IN PROD** — commit `484d08d7`, deploy READY, cursor observed walking `0 → 500 → 1000` across consecutive runs. Page size is **500**, not the 900 the handoff prescribed: fmv-recalc runs average 181s against `maxDuration=300` and **23.6% are killed at the wall**, and a killed run retries the same offset, so 900 risked re-stalling the sweep. `maxDuration` can be raised (Pro cap is 800, not the 300 currently set) — queued as a cost decision.
>
> **Item 3 (identify the third slow board) is DONE, and this document's assumption about which boards they are was wrong.** They are not `topshot_perfect_mint_premiums_board` / `topshot_pack_reality_dist` (both since re-budgeted). The live three: `candy_special_serials_board` (2.73× over — **fixed, 7,388ms → 58ms**, output proven identical), `topshot_first_mint_trophy_stats` (1.04×) and `topshot_first_mint_trophies` (1.02×). The latter two are threshold-flapping; their plan is already optimal (a restructure was tried and measured **5× slower**), so the open question there is the budget, not the query.
>
> **Gate 1 item 2 (Candy FMV denorm) re-verified DONE**: 25,375 rows, 0 NULL, $137,607.85. Item 3 (Golazos shells) draining 4,249 → 3,905. Item 4 (UFC) is shipped for SEO + banners on overview/collection/sniper/edition; residual gap is UFC's `analytics` + `sets` tabs only.
>
> ⚠ **The §3.1 HIGH/MEDIUM accuracy table in the parent roadmap was measured through the stall and is due a re-measure now that the sweep walks the whole catalogue (~5h per pass).** Same for the `fmv_apply_thin_sale_haircut` prediction and the `topshot_fmv_pct_stale_30d` re-baseline — both were correctly sequenced behind item 0.

# Roadmap amendment — 2026-08-03 (evening)

**Amends `docs/strategy/roadmap-2026-08-03.md`. Does not supersede it.** The gate, the guardrails, and §6–§9 all stand unchanged. This document corrects §5.1, re-scores the Gate 1 list against live prod, and inserts one item ahead of everything else.

All figures re-queried live **2026-08-03 ~20:00 UTC (13:00 PT)** — 17 hours after the morning roadmap.

---

## The headline change

The morning roadmap put one item in front of Gate 1: finish the dust-floor verification, because "everything below assumes FMV is now approximately right." That was the correct instinct. The verification has now been done, and it produced a different answer than either outcome the roadmap anticipated.

**The dust-floor removal is correct and confirmed. The mechanism that was supposed to propagate it across the catalogue has not moved since it was built.**

`fmv-recalc` paginates the catalogue with a cursor in `pipeline_runs.cursor_after`. It asks PostgREST for a 2,500-edition page; PostgREST caps RPC results at 1,000 rows and returns 1,000. The route computes `hasMore = pageEditionIds.length === limit` — 1000 ≠ 2500 — concludes there is no next page, writes `cursor_after = NULL`, and the following run restarts at offset 0. Every run for the last 20 hours logged `cursor_before='0'`, `cursor_after=NULL`, `rows_written=997`.

There are **11,602** editions with a sale in the 30-day window. The sweep reaches ~1,000 of them. **74% of the actively-traded catalogue has never been recomputed by the current algo** — not since the dust-floor removal, and not since the cursor was introduced.

The code comment at the cursor read documents this exact failure being found and fixed on 2026-05-23: *"without a persisted cursor every run reprocessed page 0, so ~95% of editions were never recomputed."* The cursor was the right fix. The row cap silently defeated it, and it has run `ok=true` ever since.

Full write-up and the code change: `docs/handoff-2026-08-03-fmv-sweep-cursor-stall.md`.

---

## §5.1 — corrected, and it does not close on a timer

The morning roadmap said: re-run the split at 24h and 48h, expect the pre-fix cohort to drain. Claude Code's 08-03 pass reached a compatible conclusion and set a date — *"residual is propagation only … re-measure after 2026-08-08."*

**Neither will happen on its own.** Re-measuring on 08-08 would have returned the same numbers and been read as a second confirmation of a healthy system.

Split re-run at 17h (`≥4` sales in 30d; ratio = published FMV ÷ that edition's own 30d realised median):

| Collection | Cohort | Editions | median | p90 | >2× |
|---|---|---|---|---|---|
| Top Shot | **post-fix** | 1,317 | **1.000** | **1.124** | **2** |
| Top Shot | pre-fix | 3,011 | 1.006 | 1.889 | **264** |
| All Day | **post-fix** | 197 | **1.000** | **1.226** | **6** |
| All Day | pre-fix | 1,361 | 1.000 | 3.000 | **194** |

**Read the post-fix rows as the verdict on the dust-floor decision: confirmed, at ~2× the morning's sample.** Top Shot post-fix sits at 1.000/1.124 against the never-floored `cold-tail` control's 1.000/1.060, with 2 editions above 2× out of 1,317. The change was right.

**Read the pre-fix rows as the verdict on the pipeline: 458 editions (264 TS + 194 AD) publish an FMV more than double their own 30-day realised median on the live site right now**, and no scheduled process will reach them.

The tell that separates the two, and the reason this is propagation rather than a modelling error: median time since last sale is **17.8h** in the post-fix cohort and **100.9h** in the pre-fix cohort. That is the exact signature of a recency-ordered page that never advances.

Top Shot's latest snapshot is on average **456.8 hours old (19 days)**; the oldest is **1,505 hours (63 days)**.

**§5.1 closes when `cursor_before` advances across runs and the pre-fix cohort drains — not on a date.**

### The haircut question is still open, and now it is answerable

The morning roadmap flagged `fmv_apply_thin_sale_haircut` as an untested prediction: the decision doc claimed the haircut "stops selecting them once counts are honest." That could not be tested at 48 minutes, and it cannot be tested now either — the haircut cohorts sit in the 74% the sweep never reaches. **Re-run that measurement after the first full sweep completes.** It is a genuine second-defect candidate and it has never had a fair test.

---

## Gate 1 — re-scored against live prod

| # | Item | Morning status | **Now** |
|---|---|---|---|
| 0 | **Unstick the FMV sweep** | not known | **NEW — blocks 1, and blocks Gate 2's measurement** |
| 1 | Finish dust-floor verification | open | **direction confirmed; magnitude blocked on #0** |
| 2 | Denormalise Candy FMV into `wallet_moments_cache` | 25,375 rows / 100% NULL | ✅ **DONE — 25,375 rows, 0 NULL, 0 missing `edition_key`** |
| 3 | Drain Golazos shells | 4,249 | **3,905 — draining ~344/17h, ≈8 days to clear** |
| 4 | Label dead-market surfaces (UFC) | open | open — unchanged, and still correct to do |
| 5 | Pack EV actionable vs retired in the UI | open | open — 108 of 4,596 is still the number to design around |

**Item 2 is closed.** A Candy wallet no longer totals $0. That was the roadmap's "single worst defect class" and it is gone — worth noting because it was fixed by the `wmc-fmv-populate` arm running 1,586 times in 24h, not by a heroic intervention.

**Item 0 now sits ahead of item 1** because it is the mechanism item 1 depends on. It is a four-line route change.

### Why item 0 outranks the rest of Gate 1

Gate 1's purpose is "nothing renders a number we know is wrong." Items 3–5 are labelling: they make honest gaps visible. Item 0 is different in kind — it is the difference between *a fix that shipped* and *a fix that shipped and reached the product*. Every accuracy number in §3 of the morning roadmap was measured on a catalogue that is 74% un-recomputed, which means **the All Day 6.3% and Top Shot 17.3% HIGH/MEDIUM figures that Gate 2 is scoped against are themselves measured through the stall.** Those numbers may improve on their own once the sweep runs, or they may not — but Gate 2 cannot be scoped honestly until the measurement is taken on a catalogue the pipeline has actually visited.

---

## Platform health — 30/32 ok, and the monitors could not see this

Two breaches, neither of them the stall (a third has since been added deliberately — see below):

- **`unmapped_resolution_backlog_max` = 105** (breach 100) — carried, honest. Fix remains a permanent-failure *reason* the resolver records and the arm excludes by.
- **`public_board_slow_count` = 3** (breach 1) — **new since 08-01**, when all 45 boards were clean. This arm warns before a public board renders empty, which is the behaviour we want; identify the third board. Two known true findings sit under it already (`topshot_perfect_mint_premiums_board` 14.8s warm, `topshot_pack_reality_dist` 8.4s).

**The instrument lesson, which is the §7 rule biting again:**

- `topshot_fmv_stale_hours` = **0.1 → ok**. It reads only the freshest row. A sweep pinned to the top 1,000 most-recently-traded editions writes fresh rows constantly. This metric is structurally incapable of seeing the stall, and its own `catches` text says so.
- `topshot_fmv_pct_stale_30d` = **32.2 → ok** (breach 50). This arm was built for exactly this failure — its `catches` text reads *"catches a partial/selective writer stall the freshness sentinel structurally cannot see."* Right idea, and it still didn't fire. Its recorded baseline is **32.3% on 2026-07-25** and it reads 32.2% today. **The baseline was taken while the sweep was already stuck**, so the threshold was set 18 points above the broken steady state. A permanent plateau produces no trend, and a trend-shaped threshold cannot catch a plateau.

That is a new entry for the measurement-lies catalogue, and a sharper version of the §7 rule: *validating the instrument is not enough if the instrument was calibrated against the defect.* A baseline captured from a running system encodes whatever was already broken.

**✅ SHIPPED this session** — `fmv_sweep_stall_pct_24h`, migrations `audit_20260803_fmv_sweep_stall_trust_arm` + `audit_20260803_fmv_sweep_arm_restore_security_invoker`:

```
fmv_sweep_stall_pct_24h
  = share of fmv-recalc runs in 24h that started at cursor_before='0'
  breach_at: >= 50     -- healthy 13-page sweep ≈8%; stuck = 100%
                       -- 999 when there are no runs at all: absence must not read as health
```

Reads **100.0 → BREACH** right now, which is correct and is now the loudest signal on the board. The board goes 32 → 33 arms, 2 → 3 breaches.

The direction was inverted from the proposal in the handoff (`distinct offsets < 2`) because the view's status rule is `value >= breach_at → BREACH` — a "lower is worse" metric would have read permanently green. Worth stating: the first draft of the arm that catches this class would itself have been silently broken.

⚠ **`CREATE OR REPLACE VIEW` dropped `reloptions` again** — verified NULL immediately after the splice, then restored by `ALTER VIEW ... SET (security_invoker = on)`. This is the second occurrence in three days. It is not a one-off; **any** migration touching this view must re-apply it in the same change. `check_public_security_invariants()` and `check_secdef_anon_execute_violations()` both return `[]` after the restore.

And after the first full sweep, **re-baseline `topshot_fmv_pct_stale_30d` and lower `breach_at` to ~1.5× the new floor**, or it stays decorative.

---

## Verified from the 08-03 Claude Code pass

Checked against prod rather than transcribed:

- ✅ `v_rpc_trust_health` carries `reloptions = {security_invoker=on}` — the `CREATE OR REPLACE VIEW` reloptions drop was real and the restore held. Security invariants return `[]`.
- ✅ Trust health 32/34, both breaches accounted for above.
- ✅ Candy wallet enrichment complete (0 NULL on FMV and `edition_key` across 25,375 rows).
- ⚠️ **Item 1's closure is corrected, not overturned.** The dust-floor removal did fix All Day — the post-fix cohort proves it. The re-measure date was the wrong close-out, for a reason nobody had measured yet.

That correction is worth stating plainly because it is the fourth instance this week of the same shape: **a conclusion drawn from a pipeline's *output* without checking the pipeline's *coverage*.** The morning roadmap's §7 lists nine others.

---

## The to-do list, in order

**Claude Code — ship next:**

1. **Unstick the FMV sweep** — `docs/handoff-2026-08-03-fmv-sweep-cursor-stall.md`. Four lines, one file, one commit. Verify `cursor_before` advances within 40 min.
2. After the first full sweep (~4h): re-run the pre/post split, re-test the `fmv_apply_thin_sale_haircut` prediction, re-measure the §3.1 HIGH/MEDIUM table.
3. Identify the third slow public board behind `public_board_slow_count = 3`.

**Cowork — shipped this session:**

4. ✅ `fmv_sweep_stall_pct_24h` trust arm — live, breaching at 100.0, `security_invoker` restored.
5. ✅ `submit_allow_list_request` anon `EXECUTE` — **was already revoked.** Live grants are `postgres` and `service_role` only; no `anon`, no `authenticated`, no `PUBLIC`, and no second overload. The 07-31 roadmap carried this as open for three days and it had already been closed. `check_secdef_anon_execute_violations()` returns `[]`. **Strike it from the queue.**

**Cowork — next, but sequenced:**

6. `topshot_fmv_pct_stale_30d` re-baseline — *after* #1 and #2, not before. Re-baselining now would just re-encode the stall, which is the exact mistake that made this arm useless in the first place.

**Trevor — yours:**

7. **Nothing is blocked on you right now.** The Gate 1 work is mechanical. The two decisions still parked are the Panini HIGH-confidence ruling and the `user_wallets` migration scope — both sit behind item 1.

**Unchanged and still true:** accuracy is the gate, zero users is the correct output, no promotion. Nothing in this amendment moves that.

---

## One line

The dust-floor fix was right, the verification was right to demand, and the thing that broke was the part nobody thought to measure — whether the pipeline that publishes the fix ever visits the catalogue. It doesn't. That is four lines of code and about four hours of sweep away from being true.
