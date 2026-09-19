# The Atlas listing-lane fix has a CONTAMINATED baseline, and its 24 h falsifier should say so

**Filed 2026-09-19 01:30Z (2026-09-18 6:30 PM PT) · Claude Code cloud · READ-ONLY, nothing shipped**
**A control for another session's fix, not a challenge to it.** ⛔ **R101 is that session's row and was worked <1 h ago — not touched here, per the claim convention.**

## How this came up

Re-deriving R29 (`job startup timeout`) with a positive control on the classifier showed the class had
**lost its majority**: over 8 days, `statement timeout` is **2,142 of 3,110** pg_cron failures (68.9%)
against `job startup timeout`'s **963** (31.0%). Attributing that dominant class gives:

| job | timeouts | % of ALL pg_cron statement timeouts | % of own runs |
|---|---:|---:|---:|
| **`rpc-ts-listings-atlas-sync`** | **1,231** | **57.5%** | 22.3% of 5,525 |
| `rpc-allday-unmapped-atlas-resolver` | 359 | 16.8% | 15.7% |
| `rpc-atlas-market-drain` | 289 | 13.5% | 5.0% |

⭐ **Three Atlas lanes are 87.7% of every statement timeout in the fleet.** The top one is R101's subject,
and `388dc4783` (autovacuum scale factors 0.2/0.1 → 0.02/0.02 on `topshot_atlas_market_events`) shipped
for it **tonight**, with a stated falsifier to be tested **after 24 h**.

## The finding: the window that fix will be measured against is not a valid baseline

**1. The lane has NO quiet hour in its real baseline.** Timeouts by hour-of-day, 7 days, *excluding* the
last 14 h:

| hour UTC | 00 | 03 | 06 | 08 | 10 | 13 | 15 | 17 | **18** | 20 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| timeout % | 19.6 | 10.5 | 14.9 | 8.6 | 8.1 | 34.1 | 7.2 | 43.0 | **55.2** | 40.0 | 25.3 | 18.7 |
| avg secs | 41.4 | 27.6 | 33.1 | 26.6 | 26.8 | 55.9 | 25.0 | 73.0 | **84.6** | 71.4 | 41.0 | 34.3 |

**Every hour of the day sits between 7.2% and 55.2%, at 25–85 s average.** Zero-timeout hours were never
normal for this lane, so "no timeouts since the fix" is a claim the baseline makes easy to over-read.

**2. 🚨 TODAY'S 6 AM – 12 PM PT WINDOW IS CONTAMINATED BY THE #122 OUTAGE AND MUST BE EXCLUDED.** Hourly,
today:

| hour UTC | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 00 | 01 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| runs | 30 | 30 | 30 | 30 | 30 | 30 | 29 | 30 | 30 | 30 | 30 | 30 | 14 |
| timeouts | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | **4** | **3** | 0 | 0 |
| avg secs | 3.5 | 2.7 | 2.8 | 3.2 | 2.1 | 3.4 | 19.1 | 12.8 | 13.0 | 29.7 | 38.6 | 18.4 | 21.7 |

⛔ **Those 2.1–3.5 s averages are not the lane going fast — they are the lane NOT DOING ITS WORK.** #122
was an **outbound-path** failure (the instance lost DNS) while Postgres kept serving, so a lane that
calls out short-circuits in ~3 s instead of paying its 25–85 s. **A "0 timeouts, 3 s average" hour is the
signature of a broken lane, not a healthy one** — and six consecutive such hours sit immediately before
this fix.

**3. The improvement STARTED BEFORE THE FIX COULD ACT.** The migration applied **2026-09-19 01:13:33Z
(6:13 PM PT)** and the first autovacuum under the new setting ran **01:15:18Z (6:15 PM PT)** — confirmed
from `pg_stat_user_tables`, where **`vacuum_count = 0` and `last_vacuum` is NULL**, so no manual vacuum
was ever run and the autovacuum is the only candidate. **But the lane's last statement timeout was
2026-09-18 23:06:01Z (4:06 PM PT) — two hours and seven minutes earlier**, and 20:00–21:00Z had already
gone 60 consecutive ticks clean at 12.8–13.0 s against a 40.0% / 71.4 s baseline.

**4. Post-fix evidence is ~14 ticks over ~13 minutes, and shows no step change yet.** The 01:00Z hour
reads **0 timeouts, 21.7 s average** — against the *pre-fix* 00:00Z hour's **0 timeouts, 18.4 s**. On the
production-caller signal the two are indistinguishable so far.

## ⛔ What this does NOT say

**It does not say the fix is wrong.** The mechanism is well evidenced (an index-only scan with 117,758
Heap Fetches is the registered tell for a rotted visibility map) and 13 minutes proves nothing either
way. ⭐ **It says the fix's own exit number needs a baseline that excludes 13:00–19:00Z today, and that
"timeouts since apply = 0" would over-credit it** — the lane had already been clean for two hours before
the migration existed.

## Proposed amendment to that falsifier (for whoever tests it at 24 h)

1. **Exclude 2026-09-18 13:00–19:00Z** from every before/after comparison (outage contamination).
2. **Compare hour-of-day against hour-of-day**, not against a pooled mean — the baseline swings 7.2% →
   55.2% across the day, so a pooled figure can be moved by *when* the sample was taken.
3. **Carry `avg_secs` beside the timeout count.** Timeouts are a censored measure (they only fire at the
   cap); duration moves before the count does, and would have shown the 20:00Z improvement two hours
   before the fix landed.
4. **Take the no-change control the fix cannot move:** `rpc-allday-unmapped-atlas-resolver` (359
   timeouts, 15.7% of own runs) reads a **different** table and is untouched by this migration. If it
   improves by the same proportion over the same window, the improvement is not this fix.

**Exit for the amended falsifier:** on a full 24 h with the outage window excluded,
`rpc-ts-listings-atlas-sync` timeouts fall below ~5% of own runs in **every** hour-of-day bucket, while
the control lane's rate is unchanged. **Falsifier:** the control lane improves too, or the gain
disappears at the 17:00–21:00Z peak where the baseline is worst.

---

## ⭐ FOLLOW-UP 2026-09-18 7:3x PM PT — THE CAUTION ABOVE IS CONFIRMED, AND THE STORY INVERTS

An hour on, with the sample the 13-minute reading did not have. **The autovacuum setting SURVIVED the R101 revert** (`reloptions` still `0.02/0.02`), so it can be split cleanly. Three phases, `rpc-ts-listings-atlas-sync`:

| phase | window (PT) | ticks | timeouts | % | avg secs |
|---|---|---:|---:|---:|---:|
| 1 · post-recovery, **before** the autovacuum fix | 12:02 → 6:12 PM | 186 | 8 | **4.3%** | 21.9 |
| 2 · autovacuum fix **+ R101 bodies live** | 6:14 → 7:14 PM | 31 | 12 | **38.7%** | 71.4 |
| 3 · after the R101 **revert** (autovacuum still on) | 7:16 → 7:28 PM | 7 | 4 | **57.1%** | 104.7 |

⭐ **THE CENTRAL CAUTION IS BORNE OUT.** This filing warned that *"timeouts since apply = 0"* would over-credit the fix. Pooled since apply it is now **16 of 38 = 42.1%**, and **no phase after the fix is below 38%**. The 13-minute zero was the quiet tail of phase 1, exactly as flagged.

🚨 **AND THE INVERSION: the six hours BEFORE the fix were the lane's best stretch on record — 4.3% / 21.9 s against a 7-day baseline of 7.2–55.2% / 25–85 s.** That is the point this filing was making from the other direction: **the post-outage window is not a valid baseline, and here it was anomalously GOOD rather than anomalously bad.** Anyone comparing "after the fix" to "the hours before it" will read a large regression that the fix may have nothing to do with.

⛔ **CAUSE NOT ASSERTED, and three reasons why it must not be.** (a) Phase 2 straddles **two** concurrent changes — the autovacuum setting and the R101 bodies — so it cannot attribute to either. (b) Phase 3 is **7 ticks over 12 minutes**, below anything worth a verdict. (c) The revert commit itself records an **IO spell**, and `avg_secs` of 104.7 is consistent with one, so load is an unexcluded confound. ⚠ **What can be said: the autovacuum change has NOT demonstrated a gain, and the lane is currently worse than in the hours before it landed.**

**Amended exit, unchanged in spirit:** judge it on a full 24 h, **hour-of-day against hour-of-day**, with 13:00–19:00Z excluded AND **phase 1 excluded too** — it is now demonstrably not representative either.
