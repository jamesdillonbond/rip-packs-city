# 🚨 I executed the suppressions' own predicates instead of reading them — 2 of 3 hold, 1 fails, and one lane now has **no scheduler, no alarm and no suppression** at once

*Filed 2026-09-14 ~08:14 AM PT by Cowork (cloud). **READ-ONLY — nothing changed in the DB or the repo's alerting.** The decisions this points at are already registered as #101 and #102 and are Trevor's; this exists because their evidence was 9 days old and one number in it has moved.*

## ⛔ CORRECTION 2026-09-14 ~08:5x AM PT — SECTION 2's HEADLINE IS WITHDRAWN BY ME, ABOUT 35 MINUTES AFTER I PUBLISHED IT

**The title of this filing is wrong and I am not rewriting it away.** Section 1 (the predicates) stands unchanged. Section 2's *"no scheduler, no alarm and no suppression"* does not, on two counts.

### 1 · I conflated two rows whose names differ only by hyphen vs underscore

- `allday-pack-opens-backfill` (**HYPHENATED**) — the failure-rate suppression. **Expired 09-07, correctly, as designed.** That is the row in my expiry table.
- `allday_pack_opens_backfill` (**UNDERSCORED**) — the cursor-keyed suppression. **`expires_at IS NULL`. It is PERMANENT and live.**

I read the first row's expiry as the second row's and wrote "no suppression". ⛔ **There is a suppression, and it never expired.** The row itself warns about exactly this: *"the failure_rate arm … keys on the HYPHENATED pipeline name and is therefore unaffected by this (underscored, cursor-keyed) suppression."* **The repo's two-vocabularies footgun, in a table I was auditing for false claims.**

### 2 · The false floor claim was TRUE when I measured it and was corrected while I was writing

The reason now opens: *"Terminal because the lane has NO CALLER since 2026-09-04, not because it reached its floor. **CORRECTED 2026-09-14 ~08:20 AM PT** — the sentence that stood here claimed a terminal state at the RAISED spork floor, and the cursor is 18,011,710 blocks ABOVE that floor (83,276,329 vs 65,264,619)…"*

⭐ **Those are my numbers, to the block.** A concurrent Claude Code session found the same defect in the same hour and **fixed the record**; I measured it at ~08:0x, published at ~08:15 that the record was wrong, and it had been right for five minutes by then.

### 3 · 🚨 THE PICKUP I RECOMMENDED IS THE ONE THE ROW EXPLICITLY WARNS AGAINST

I wrote *"restore a pg_cron job in the shape of jobid 56."* The corrected row says:

> **"SO THERE IS NO CADENCE NET FOR THIS LANE, AND THAT IS INTENTIONAL** — the lane has no caller at all, so an alarm on it would be permanently red. **Do NOT 'restore' the watchlist row without first giving the lane a caller AND re-checking the pg_net blocking that killed it."**

⛔ **The absence is a decision, not a gap.** jobid 55 was unscheduled and the watchlist row retired **deliberately** on 09-04: **25 of 25 ticks in four hours died at the pg_net 90 s wall and head-of-line blocked every other pg_net request on the platform.** AllDay is sunset. Restoring it in jobid 56's shape without re-checking that blocking would re-create a platform-wide stall to walk ~19 M blocks of a sunset collection.

### 4 · What survives, and one thing that is better than what I filed

- ✅ **Section 1 is untouched** — 2 predicates hold, `topshot-misattrib-drain` fails at 1,364, and the rate disagreement stands.
- ✅ **The four expiries are real**, and the reading *"expiry is not a defect; expiry while the lane is still unwatched is"* survives — it was the second clause I got wrong, not the first.
- ⭐ **`check_suppression_parked_claim_drift()` ALREADY EXISTS** and parses the claimed floor out of the reason with a regex. **It returns `[]` — and that is now CORRECT**, because the claim it would have caught was removed at 08:20. I opened this expecting a false negative from a guard that should have seen what I saw by hand; instead the guard agrees with a record that had already been fixed. **The instrument for this class is built; what it needs is a caller, not a rewrite.**
- ⭐ **The transferable lesson, which is the reason this correction is long:** the repo already says *re-read the ledger from disk immediately before writing it* because sessions write concurrently. **The same rule applies to any claim about a DB text column** — `reason`, `notes`, a watchlist note. I based a published claim on a value I had read 10 minutes earlier, and `left(reason, 400)` had already hidden one correction from me earlier in the same pass. **Re-read the row immediately before asserting what it says.**

---

## 0 · Why this pass happened at all

Register **#102(c)** names the structural defect and nobody has acted on it:

> ⭐ **The structural fix: these predicates are prose in a `reason` column that nothing evaluates** — the same root as #101. **A predicate nothing runs is a comment.**

So I ran them. `pipeline_alert_suppression.reason` contains, in five rows, a literal SQL predicate the author wrote down as the thing that must stay true. **Three are directly executable booleans.** Executing three statements is the entire method — there is no cleverness here, which is rather the point.

## 1 · The three executable predicates, run 2026-09-14 08:0x AM PT

| suppression | its own predicate | holds? | observed |
|---|---|---|---|
| `ingest-topshot-challenges` | `max(updated_at) > now() - interval '7 days'` on `challenges` | ✅ | `2026-09-14 07:20:00Z` — jobid 87 ran this morning, exactly as the reason predicts |
| `topshot-catalog-backfill` | `count(*) >= 500` on Top Shot `editions` updated <24 h | ✅ | **3,890** |
| `topshot-misattrib-drain` | `count(*) <= 500` open misattrib candidates | ⛔ **FAILS** | **1,364** |

⭐ **Two holding is not a throwaway result** — it is the control. A checker that only ever reports failure is indistinguishable from a broken one, and these two prove the method reads live state rather than restating the prose.

⚠ **The failing one is already correctly recorded.** `topshot-misattrib-drain`'s reason carries a `[CORRECTION 2026-09-13]` block stating the predicate has failed and why it is deliberately not deleted. **I nearly re-did that amendment** because a 400-character preview of the column hid it — the correction sits at character 720. *Read the whole column before concluding a record is stale.*

📏 **The one genuinely new number: 1,315 (09-13) → 1,364 (09-14) = +49 in one day.** #101 records the accumulation as **~117/day** from two indirect rates. **These disagree by ~2.4×**, and nothing can adjudicate: `rpc_trust_health_history` holds **no** misattrib metric (checked — 0 rows for any `%misattrib%`/`%backlog%` metric), and its whole buffer is only 7–11 points per metric. ⛔ **So do not replace 117/day with 49/day either** — one delta of a once-daily MV snapshot (jobid 70, `35 23 * * *`) is not a rate. **The honest statement is that the number gating #101 has never been instrumented**, and a series is cheap if anyone wants the rate settled.

## 2 · 🚨 The finding: four suppressions have EXPIRED, and one of them was the only thing left watching a dead lane

`expires_at < now()` on four rows:

| suppression | expired | lane state now (7 d) |
|---|---|---|
| `allday-pack-opens-backfill` | **09-07 (7 d ago)** | 🚨 **0 runs** |
| `allday-lock-refresh` | 09-08 (6 d ago) | 70 runs / 4 failed, last ok 09-14 14:23Z — healthy, row is spent |
| `offers-sweep` | 09-14 | 5 runs / **5 failed**, none since 09-12 — matches its own reason (caller removed 09-12), benign |
| `ts-listings-atlas-sync` | 09-14 | 1,368 runs / 2 failed — healthy; it was a timed shed and it expired on time |

### `allday-pack-opens-backfill` — all three instruments are off at once

- **No scheduler.** `cron.job` has **no** `rpc-allday-pack-opens-backfill` (jobid 55) at all. Its Top Shot twin, **jobid 56 `rpc-topshot-pack-opens-history`, is present and active** — so the shape the register proposes copying does exist.
- **No alarm.** `pipeline_cadence_watchlist.is_active = false`.
- **No suppression.** The row expired 09-07.
- **Cursor frozen `2026-09-04 04:56:25Z` — 10.4 days — at block `83,276,329`.**

⛔ **And its suppression's headline claim is false by its own arithmetic.** The reason says *"Terminal state at the RAISED spork floor 65,264,619"*. The cursor sits **18,011,710 blocks ABOVE that floor**. Terminal means at the floor; this is not at the floor.

⭐ **The twin is the control, and it exonerates the claim-shape rather than the claim.** `topshot_pack_opens_history_backfill` is frozen 38.7 days at **61,808,846** — genuinely **below** 65,264,619, so *its* "parked below the raised floor" suppression is **TRUE**. **Same sentence, same table, one true and one false** — which is why reading these rows cannot substitute for running them.

## 3 · What this is and is not

- ⛔ **Not a new defect.** #102 already records this lane as its live casualty (*"stopped 09-04, nine days silent, nothing alerted"*). **What is new: it is now 10.4 days, and the suppression that was still nominally covering it has since expired**, so the count of instruments that could notice has gone from one to zero.
- ⛔ **Nothing flipped.** Re-enabling `is_active` is #102's decision (a) and it explicitly warns not to flip it without also re-scoping the false "parked" grants, *"or the same rows will page for lanes that really are terminal."*
- ⚠ **A cheap trap avoided:** three of the four expired rows are **correct to have expired** — they were written as temporary and they timed out as designed. **Expiry is not a defect; expiry while the lane is still unwatched is.** Any future sweep should join expiry to lane state, never alarm on expiry alone.

## 4 · The pickup, in the order that costs least

1. **Decide `allday-pack-opens-backfill`** (#102's decision, unchanged): restore a pg_cron job in the shape of **jobid 56**, or accept the coverage gap — and either way **rewrite the suppression, whose "terminal at 65,264,619" is 18.0 M blocks wrong.** ⚠ Whoever restores it should first establish *why* it stopped on 09-04; nobody has.
2. **Delete the two spent rows** (`allday-lock-refresh`, `ts-listings-atlas-sync`) — both lanes measured healthy above, both rows were explicitly temporary.
3. **If anyone wants #101's rate settled**, record the open-backlog count once a day. It is one number and nothing keeps it today.
4. ⭐ **The structural item stays open and is the valuable one:** three predicates were executable and I ran them by hand, in a session that happened to look. **Nothing in the estate runs them on a schedule.** A curated checker (the SQL written in the repo, not `EXECUTE`d out of a text column — those rows are operator-written and dynamic SQL from them is an injection surface) would turn three comments into three checks.

**Method, so it can be repeated or refuted:** `pipeline_alert_suppression` / `pipeline_cadence_watchlist` / `pipeline_runs` / `event_cursor` / `cron.job` / `rpc_trust_health_history`, six read-only queries, Supabase MCP, 2026-09-14 08:0x–08:1x AM PT.
