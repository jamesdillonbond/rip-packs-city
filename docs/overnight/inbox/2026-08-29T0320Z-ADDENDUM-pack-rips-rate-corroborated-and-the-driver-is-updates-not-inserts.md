> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# ADDENDUM to `2026-08-29T0241Z-pack-rips-insert-rate-measured-...` — the rate is corroborated by a second instrument and is ~2.5× higher, and the insert path is the *smaller* of the two drivers

**2026-08-29 03:20Z · Cowork cloud pass (continuation)**
⚠ Scope: no-push is specific to this cloud session; Trevor's box and Claude Code push normally via the
PAT in `remote.origin.pushurl`. Nothing in this addendum touched prod.

**This does not overturn the parent filing's conclusion — 2000/0.01 is still wrong for `pack_rips`, and
declining the `created_at` seq scan was still right.** It corrects one number and adds one mechanism.

---

## 1. The insert rate has a second, independent instrument — and it reads ~2.5× higher

The parent filing notes it could not corroborate with `n_tup_ins` because `stats_reset` is NULL. There is
a clean short-window instrument that does not depend on `stats_reset`: **`n_ins_since_vacuum` measured
against a known `last_vacuum` timestamp.**

```
pack_rips  last_vacuum = 2026-08-28 22:57:25Z   (the tmp-vacuum-pack-rips one-shot)
           n_ins_since_vacuum = 508  at 2026-08-29 03:05Z
           elapsed 4.13 h  ->  ~123/h  ->  ~2,950 inserts/day
```

No `sealed_at` proxy, no stats_reset dependency, no seq scan. It agrees with a 13-month `sealed_at`
histogram I ran separately (400-day window, Index Only Scan, 3.2 s):

| month | rips/day | | month | rips/day |
|---|---:|---|---|---:|
| 2025-08 | 3,225 | | 2026-03 | 1,461 |
| 2025-09 | 2,464 | | 2026-04 | 2,057 |
| 2025-10 | 2,715 | | 2026-05 | 2,906 |
| 2025-11 | 3,025 | | 2026-06 | 2,175 |
| 2025-12 | 2,890 | | 2026-07 | 1,641 |
| 2026-01 | 2,424 | | 2026-08 | 1,358 |
| 2026-02 | 2,690 | | | |

⭐ **~1,200/day is the trough, not the characteristic rate.** August 2026 is the slowest month on record
and the last 21 days are slower still. The 13-month envelope is **1,358–3,225/day, median ~2,464**, and
the direct counter puts *right now* at ~2,950/day.

**Consequence for the recommendation:** `8000 flat` fires every **2.7–5.9 days** across the envelope, not
6.7. That is *better* than the filing claims — it strengthens the case. But 6.7 days quoted alone invites
the next reader to shave the threshold, so the envelope belongs in the record.

⭐ **And it kills my own worry before anyone spends time on it:** I was going to object that
`scale_factor = 0` has no ceiling if inserts ever burst. Thirteen months show **no burst** — max month is
only 2.4× the min — and there is no `pack_rips` backfill route in `src/app/api`. The objection is not
supported; one line in the migration header noting the behaviour is enough.

---

## 2. 🚨 THE BIGGER CORRECTION — `pack_rips` is UPDATE-churned, and an insert threshold is aimed at the smaller driver

```
pack_rips   n_tup_ins  20,869
            n_tup_upd 114,542      <- 5.5x the inserts
            n_tup_hot_upd      0   <- EVERY update is non-HOT
```

`n_tup_hot_upd = 0` means every update writes a new tuple version and **clears the page's all-visible
bit**. So the visibility map is being dirtied 5.5× faster by a path that
`autovacuum_vacuum_insert_threshold` does not watch at all.

**Measured drift, 4.13 h after the 22:57Z vacuum:** `n_dead_tup` = 2,016 → ~490/h → ~11,700/day. The
dead-tuple trigger is `50 + 0.05 × 3,673,296` = **183,722**, i.e. **~15.7 days away**.

⭐ **That is the Project's "goes stale again in about three weeks" prediction — and it is arriving down the
DEAD-TUPLE path, not the insert path.** The prediction the whole recommendation is anchored on, and the
lever the recommendation proposes, are watching different counters.

**And the plan already shows the drift, only 4 h after a full vacuum:** `mv_allday_pack_realized`'s body
now runs an Index Only Scan on `idx_pack_rips_dist_agg` with **Heap Fetches 23,010** — already 45× the
508 inserts, because the source is updates.

👉 **Revised shape, offered as a correction rather than a counter-proposal:** whatever insert threshold is
chosen, `pack_rips` also needs its **`autovacuum_vacuum_scale_factor`** brought down from 0.05 (trigger
183,722) to something the ~11,700/day dead-tuple rate reaches on the intended cadence — e.g. `0.002`
→ trigger ~7,400 → ~0.6 days, or `0.01` → 36,783 → ~3.1 days. ⛔ **I did not measure steady-state vacuum
cost on a 756 MB heap either, so I am not naming a number** — but sizing the insert path alone will not
hold the map, and the next pass should not conclude the fix worked when the map rots anyway.

---

## 3. ⭐ AND THE 22:57Z VACUUM ALREADY PAID OFF SOMEWHERE NOBODY CONNECTED IT

`jobid 211 rpc-refresh-allday-pack-realized` — the #27 board-MV class, and the job whose reschedule
experiment was refuted on 08-28:

| run | result |
|---|---|
| 2026-08-27 18:35Z | ❌ 600.0 s timeout |
| 2026-08-28 08:35Z | ❌ 600.0 s timeout |
| 2026-08-28 14:35Z | ❌ 613.6 s timeout |
| 2026-08-28 20:35Z | ❌ 600.0 s timeout |
| **2026-08-28 00:35Z** (pre-fix, same quiet slot) | ✅ **58.8 s** |
| **2026-08-29 00:35Z** (post-fix, same quiet slot) | ✅ **1.8 s** |

⭐ **An hour-matched control — same job, same 00:35Z slot, 24 h apart, 32.7× faster.** Between them:
`idx_pack_rips_dist_agg_covering` (migration `20260828225200`, 22:52Z) and `VACUUM (ANALYZE)
public.pack_rips` (22:57Z).

⛔ **TWO VARIABLES CHANGED FIVE MINUTES APART, so I am NOT attributing the win to either.** The covering
index is the likelier primary cause (it converts a 756 MB heap read into a 30k-buffer index scan); the
vacuum is what lets that scan actually skip the heap. Both were shipped by the 22:5xZ pass and, as far as
the record shows, neither was connected to jobid 211.

⭐ **It also reframes the refuted reschedule honestly: the hour was never the cause,** which is exactly why
moving jobid 211 to quieter slots could not help and the pre-registered all-three-failed branch had to
fire. ⛔ This is **not** a reason to re-open the reschedule — that stays closed.

👉 **The decisive test is the next in-band run at 08:35Z**, the slot that has failed at 600 s three times.
If it succeeds, the visibility map + covering index were the cause of #27 for this job — and then the
`pack_rips` threshold decision stops being hygiene and becomes what keeps a 600 s cron failure from
returning.
