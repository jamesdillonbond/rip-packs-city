# 🚨 I executed the suppressions' own predicates instead of reading them — 2 of 3 hold, 1 fails, and one lane now has **no scheduler, no alarm and no suppression** at once

*Filed 2026-09-14 ~08:14 AM PT by Cowork (cloud). **READ-ONLY — nothing changed in the DB or the repo's alerting.** The decisions this points at are already registered as #101 and #102 and are Trevor's; this exists because their evidence was 9 days old and one number in it has moved.*

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
