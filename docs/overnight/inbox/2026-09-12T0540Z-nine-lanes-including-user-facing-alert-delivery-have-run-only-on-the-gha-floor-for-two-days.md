# 🔴 NINE LANES — INCLUDING BOTH USER-FACING ALERT-DELIVERY LANES — HAVE RUN ONLY ON THE GHA BACKSTOP FOR TWO DAYS, AT 8 TICKS A DAY INSTEAD OF 96–2,016

**2026-09-12T05:40Z (2026-09-11 22:40 PT) · Claude Code (cloud), autonomous session · instance quiet at measurement.**

**This is #76's unclosed tail, and nothing alarmed on it.** I found it while re-deriving **#78** (the "frozen Golazos listings" item) — which turns out to be two different phenomena stacked, only one of which is real. The bigger half is this.

## The measurement

`pipeline_runs_daily` is indefinite, so the collapse is visible as a step rather than inferred. Runs per day:

| lane | normal cadence | 09-06…09-09 | 09-10 | 09-11 | loss |
|---|---|---|---|---|---|
| `wmc-fmv-populate` | ~1 min | **2,016** | 1,182 | **91** | 96 % |
| `snapshot-pack-asks` | 5 min | **288** | 169 | **13** | 95 % |
| `alerts-send` | ~10 min | **144** | 83 | **13** | 91 % |
| `alerts-dispatch` | 15 min | **96** | 56 | **13** | 86 % |
| `allday-listings-indexer` | 15 min | **96** | 57 | **13** | 86 % |
| `golazos-listings-indexer` | 15 min | **96** | 56 | **13** | 86 % |
| `pinnacle-events-ingest` | 15 min | **96** | 56 | **13** | 86 % |
| `allday-listings-retry` · `pinnacle-listings-retry` | 15 min | — | — | **13** | same |

⭐ **The step lands on 2026-09-10 — the day of the Vercel spend-cap pause (#76)** — and the mechanism is the one `dead-lane-backstop.yml`'s own header predicted in advance: *"cron-job.org auto-disables a job after a run of consecutive failures, so across a ~10-hour outage a 4-hourly job banked 2-3 failures and survived while a 1-minute job banked ~640 and did not."* **It happened again, to the same class of lane, and this time nobody noticed for two days.**

## The primary is delivering ZERO ticks — established without the console

Two independent tells, neither needing cron-job.org access:

1. ⭐ **All nine lanes' last runs sit inside ONE second-cluster:** `02:31:27.897` → `02:31:33.013`. That is one caller running its steps in sequence — the backstop job — and there is not a single run *between* clusters. Over 24 h there are exactly **8 clusters, 8 runs per lane**.
2. ⭐ **The minutes do not match the backstop's own nominal cron either** (`12,27,42,57`): observed `48, 28, 20, 39, 17, 49, 45, 31`. That is GitHub's `schedule` delay, which is the documented reason the backstop is a **floor, not a restoration** — the workflow header measured **16 of 48 fires delivered** on this repo.

**So: cron-job.org contributes nothing, and GitHub delivers about a third of four-per-hour.** 8 ticks/day is what that arithmetic produces, and it matches.

## Why it matters, per lane rather than in the aggregate

- ⚠ **`alerts-send` + `alerts-dispatch` are the USER-FACING alert lanes.** An alert that should go out within 5–15 minutes is now going out on a gap averaging **177.6 minutes, worst observed 292.2**. CLAUDE.md names an **alert** as one of the worst sub-classes of this defect family, and right now the delay is invisible to the user: nothing on any surface says "alerting is running three-hourly".
- ⚠ **`snapshot-pack-asks` feeds Pack Sniper recency.** The 2026-09-11T18:08Z monitor filing flagged that a *sustained* silence here would have blast radius. **It is now sustained — two days.**
- ⚠ **`wmc-fmv-populate` lost 96 % of its ticks** (2,016 → 91). It is the FMV denormalisation feeder, i.e. the go-live accuracy metric's own input path.
- `allday-listings-indexer` is the second-largest marketplace's listings ingest: `cached_listings_v2` for `nfl_all_day` is newest-listed **3.0 h old** against `disney_pinnacle`'s **1.2 h** — and Pinnacle's listings indexer is the control below.

⭐ **CONTROL, same instrument, same table: `pinnacle-listings-indexer` runs 72×/24 h with an average gap of 20.0 min and a MAXIMUM of 20.1** — a different cron-job.org entry that was never disabled. So this is a property of the nine disabled entries, not of cron-job.org, not of Vercel, and not of the measurement.

## ⛔ What I could NOT do, with the reason

**A pg_cron restoration is not available to me.** Every `net.http_*` job in `cron.job` (13 of them) calls a **Supabase edge function** behind `?key=`; **not one calls a `www.rippackscity.com/api/*` route**, and those routes are gated on `INGEST_SECRET_TOKEN`, which is not in the database. Wiring one would mean planting a secret — off-limits, and I did not go looking for it.

⛔ **And I did not tighten the backstop's cron, because its own header forbids exactly that** with a measurement behind it: GitHub drops the extra fires too, and `sales-indexers-backstop.yml` already records that lesson. Tightening would buy nothing and bury the real cause.

## 🚨 OPERATOR ACTION (Trevor) — nine cron-job.org entries to re-enable

The fix is one console session. The entries, with the cadence each should return to:

```
wmc-fmv-populate          ~1 min     (2,016/day)
snapshot-pack-asks         5 min       (288/day)
alerts-send              ~10 min       (144/day)
alerts-dispatch           15 min        (96/day)
allday-listings-indexer   15 min        (96/day)
allday-listings-retry     15 min        (96/day)
golazos-listings-indexer  15 min        (96/day)
pinnacle-listings-retry   15 min        (96/day)
pinnacle-events-ingest    15 min        (96/day)
```

⭐ **Re-enabling is safe to do while the backstop keeps firing:** all ten routes were checked for idempotency before being added to the backstop (cursor + `onConflict` upserts, atomic claim-then-mark for the alert lanes, `.update()`-only for the retries) — that check is recorded in the workflow header, not assumed here. A duplicate tick advances a cursor or no-ops.

**Verification after re-enabling, one query:** runs/24 h should return to the normal column above, and the `started_at` second-clusters should disappear.

## 🚨 THE INSTRUMENT FINDING — a silence detector cannot see a cadence collapse, by construction

This ran for **two days at 1/12th cadence with every instrument green**, and the reason is structural rather than an oversight:

- `detect_stalled_pipelines()` / the `cron_silent` arm fire on **time since the last run** against a threshold of **1,800 minutes (30 h)**. A lane ticking every 177 minutes is *never* 30 h silent. **A lane at 1/12th cadence is, to a silence detector, a healthy lane.**
- `pipeline_runs` reads `ok: true` on every one of those 8 ticks, because each tick genuinely succeeded.
- The backstop is deliberately `continue-on-error` with no badge, *precisely so it does not compete with the real alarm* — so its own firing is not a signal either.

⭐ **The missing arm is a RATE arm, not a liveness arm: observed runs per window against the lane's own expected cadence.** The data to compute it already exists (`pipeline_runs_daily.runs`, indefinite, per lane per day) and a lane's normal is its own trailing median rather than a table of constants, so it needs no hand-maintained list — which is the shape CLAUDE.md prefers (a tree walk over a curated list).

⚠ **Filed rather than shipped tonight, with the reason stated:** such an arm fires immediately for these nine lanes and stays red until the console fix, which is this estate's own permanently-red-instrument trap (**#25**, and the register's note that a supply-age alert was declined for exactly this reason). It needs either the console fix first, or an evidenced suppression with a re-check condition — the `pipeline_zero_yield_suppressions` pattern. **That is the next change, not a midnight one.**

## #78 is two phenomena stacked, and its stated conclusion is refuted

#78 concludes: *"`golazos-listings-indexer` has written NOTHING for over a week while `pipeline_runs` recorded ~670 clean runs. The remaining unknown is the mechanism inside the lane — not whether it is broken."* ⛔ **The lane is not broken.** From `pipeline_runs_daily`, which the filing did not consult:

| day | runs | blocks_scanned | events_pre_filter | **events_post_filter** | written |
|---|---|---|---|---|---|
| 08-31 | 96 | 99,116 | 11,700 | **113** | 83 |
| 09-01 → 09-09 | 94–96 | ~108,000/day | 11.4k–22.8k | **0** | 0 |
| 09-03 | 96 | 107,973 | 14,215 | **1** | 1 |
| 09-11 | 13 | 152,477 | 27,837 | **25** | 8 |

⭐ **The same filter matched 113 events on 08-31 and 25 on 09-11**, so it is not mis-keyed. ⭐ **`blocks_scanned` is ~108,000/day against the ~86,000 blocks Flow produces in a day**, so no window was skipped — the lane covered the chain and the chain had nothing. ⛔ **And #78's refutation of the quiet-market hypothesis was CIRCULAR: it cited Golazos `sales` rows as proof the market was live, but those rows are written by `golazos-sales-indexer`, reading the SAME `NFTStorefrontV2` event stream at the SAME contract address.** Two lanes sharing an upstream are **one instrument** — they go quiet together, so that reading could never discriminate "lane broken" from "venue quiet". ⭐ The sales lane independently confirms the quiet today: its cursor is at the chain head (05:31Z, current), and it reports `v2_dapper_filtered_in: 0` with no Golazos type in `v2_dapper_typeids_seen` while listing TopShot, AllDay, Pinnacle, MFLPack and KARATZ types.

**So #78 splits:** *(a)* 09-01 → 09-10, the LaLiga Golazos storefront genuinely produced ~zero events while the lane ran 96×/day with full block coverage — **thin market, honest lane, no defect**; *(b)* 09-10 onward, the cadence collapse above — **a real defect, and not the lane's.** The item was filed at the transition and read (a) through (b).

⚠ **What remains genuinely open in #78, stated rather than dropped:** 530 Golazos rows in `cached_listings_v2` are still marked open with no `completed_at`, and at 8 ticks/day the lane cannot work through cancellations either. That resolves with the console fix, and should be re-checked after it — **not** treated as evidence of a broken lane.

## Re-check conditions

- **This filing's headline:** runs/24 h per lane against the normal column. If they are still 8 after the console fix, the entries were re-enabled but are failing — a different finding.
- **#78(a):** `events_post_filter` for `golazos-listings-indexer`. A non-zero day with rows written (as 09-11 already shows) is the lane working; a zero day at restored cadence is a quiet market, not a fault.
