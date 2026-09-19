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
