# ⭐ PRIORITY 1 CAPTURED, first time since 2026-07-26: **signed-in WAU is 0**, and the roadmap's accuracy gate stands at **30.1% HIGH/MEDIUM** — with three denominator caveats that change what the number means

**Filed:** 2026-08-23 ~15:05 PT (22:05Z) · **By:** Claude Code, interactive · **Status:** MEASURED, read-only. Nothing shipped, nothing recommended — this is the number `focus.md` says every other number is downstream of, and it had not been captured in four weeks.

`focus.md` PRIORITY 1: *"Demand is the only gate that matters, and it is not being measured … If a pass
captures metrics at all, capture the user/WAU count."* Last confirmed reading: **20 users / 0 WAU
(2026-07-26)**. Here it is.

## 1. Traction — measured against `auth.users`, not a view count

| | value |
|---|---:|
| total accounts | **21** (was 20 on 07-26 → **+1 in four weeks**) |
| signups, last 7 d | **0** |
| signups, last 30 d | **1** — newest **2026-08-08**, 15 days ago |
| **signed in, last 7 d → WAU** | **0** |
| signed in, last 30 d → MAU | **2** |
| accounts with a saved wallet | 21 (all of them) |

**Roadmap gate is 50+ WAU. Actual WAU is 0.** ⚠ That is not a call to chase growth — the roadmap's own
thesis is that **accuracy is the gate and growth tactics stay removed until the data beats the sites
collectors already use.** This number is here so the gate is judged on a measurement instead of a memory.

## 2. ⛔ DO NOT read `funnel_events` session counts as traction — they are wrong by ~3 orders of magnitude

7 days, rows not flagged as bots: **16,587 rows across 16,463 distinct sessions**. A reader capturing
"weekly users" from the nearest instrument would report ~16,000 and conclude the gate was smashed.

**99.67% of those sessions fire exactly ONE event and never return** (16,409 of 16,463). Only **54** sessions
reached 2 events; only **7** reached 5. ⓘ This independently reproduces the analysis already written into
`app/api/track-funnel/route.ts`'s own header (R23) — **the code was right, and it says so in a comment
nobody querying the table will read.**

The funnel, 7 d, by intent rather than by volume:

| event | sessions |
|---|---:|
| `collection_view` | 15,255 |
| `insights_view` | 1,134 |
| `home_view` | 68 |
| `share_view` | 15 |
| **`wallet_paste`** | **4** |
| `signin_click` / `account_created` | **0** |

⚠ **In the 20 h since user-agent capture began (see §3), the clean window shows 550 sessions and ZERO wallet
pastes, ZERO sign-in clicks, ZERO accounts created.** Same 1.01 rows/session shape, with only 5.8% of rows
self-identifying as bots — so **the UA heuristic catches the honest crawlers and the one-event shape still
says the rest are not browsing.** That is exactly what the route's comment predicts.

🚨 **Vercel Web Analytics is NOT ENABLED for this project** (`404 Web Analytics not found`). So `funnel_events`
is the **only** traffic instrument RPC has, and it has no independent corroborator. That is worth knowing
before anyone treats a view count as evidence of anything.

## 3. ⚠ A DATED CAVEAT ON `bot_ua`, and a near-miss worth recording

`bot_ua` and `user_agent` landed **2026-08-23 ~02:00Z**. Measured hour by hour: every hour from 02:00Z
onward carries a user agent on **100%** of rows (203/203, 84/84, 69/69, …). Before it, **zero** rows carry
one — 16,063 of 16,619 in the 7-day window.

**Those pre-02:00Z rows were written with `bot_ua = false` and no UA to classify.** `isBotUserAgent(null)`
returns `false` by design, so on that history **`bot_ua = false` means "we never saw a UA", not "human".**
⚠ **Slice `bot_ua` only from 2026-08-23 02:00Z forward.** Earlier rows are unclassifiable, and the flag reads
as a negative rather than an unknown.

🚨 **The near-miss:** I first measured "96.7% of rows have no UA" and was about to file that the flag is
*structurally blind on its own population* — this repo's canonical guard defect. **A single control refuted
it**: bucket by hour across the migration boundary. The 96.7% is entirely pre-migration absence; the
instrument is correct and complete from the moment it existed. **One query separated a real caveat from a
false accusation against working code** — the same shape as the vacuous `0 affected wallets` on the
challenge functions.

## 4. The accuracy gate — the roadmap's headline metric, measured

Share of priced editions at **HIGH or MEDIUM** confidence, from `fmv_current` (freshest row 21:58:53Z,
seconds old at capture):

| collection | priced editions | HIGH/MEDIUM | share |
|---|---:|---:|---:|
| `nba_top_shot` | 19,667 | 6,740 | **34.3%** |
| `nfl_all_day` | 6,190 | 1,323 | **21.4%** |
| `laliga_golazos` | 575 | **0** | **0.0%** |
| `ufc_strike` | 518 | **0** | **0.0%** |
| `candy_mlb` | 125 | 77 | 61.6% |
| **total** | **27,075** | **8,140** | **30.1%** |

**Three caveats, and each one changes what the number means:**

1. ⚠ **UFC's 0.0% is CORRECT, not a defect — and it drags the headline down permanently.** Its 518 rows are
   **381 `STALE` + 137 `NO_DATA`**, nothing else. UFC Strike's market has been closed since **May 2026**, so
   a live confidence is not achievable and never will be. **Excluding it: 8,140 / 26,557 = 30.7%.** An
   accuracy gate that counts a closed market cannot be moved by improving accuracy.
2. 🚨 **Golazos' 0.0% is a REAL gap, and it is a different shape from UFC.** 297 `STALE`, 110 `ASK_ONLY`,
   92 `LOW`, 76 `NO_DATA` — a live collection with **no HIGH or MEDIUM row at all**. This is the clearest
   single target the metric names.
3. 🚨 **Disney Pinnacle is not in THIS metric.** ⚠ **Refined 2026-08-24: "not in the metric" was too broad.**
   The roadmap's canonical-only precompute leg DOES cover Pinnacle (43.2% on 2026-08-22). What is true is
   narrower and still matters: **`fmv_current` — the denominator used here — carries none of it.** Measured, not inferred: **0 rows** in `fmv_current` against
   **2,564** in `pinnacle_catalog` — it prices through the separate Pinnacle path (the
   `character_name`/`set_name`/`variant_type` triple). **So "30.1% of prices" covers four of the five
   published collections.** Any headline that does not say so is overstating its own scope.

⚠ **All Day's shape is worth reading, not just its percentage:** only **184 of 6,190** rows are `HIGH`
(3.0%). Its mass is `LOW` 1,837, `ASK_ONLY` 1,339, `NO_DATA` 915, `STALE` 769.

## What this is NOT

⛔ **No recommendation, and deliberately so.** Every lever here — Golazos coverage, the Pinnacle denominator,
whether UFC belongs in the metric — is a product/priority decision, and two of them redefine the gate the
roadmap is measured against. **That is Trevor's call, and it should be made on this table rather than on an
impression.** ⚠ Every figure is a dated sample from 22:05Z on 2026-08-23; `fmv_current` moves continuously.

---

## 5. FOLLOW-UP 22:15Z — I named the wrong target in §4, and the measurement says so

§4 called **Golazos the clearest single target**. Measured, that is wrong, and the correction matters because
acting on it would have produced *fabricated confidence* rather than accuracy.

**Golazos is alive but THIN, and thin is not fixable by us.** 62 sales in 30 days across **46 editions** —
so only **8% of its 575 priced editions traded at all** — and of those 46:

| confidence | editions | sales in 30 d (min–max, avg) |
|---|---:|---|
| `LOW` | 39 | 1–3, **avg 1.4** |
| `ASK_ONLY` | 7 | 1–3, avg 1.3 |

**Not one Golazos edition that sold has more than THREE sales in a month.** No honest confidence rule
promotes a 1.4-sales-per-month edition to MEDIUM. ⛔ **So the lever here is not a threshold — dropping one to
turn these into MEDIUM would publish a confident price built on a single trade**, which is the exact
fabricated-number class this repo bans elsewhere. Golazos' 0.0% is the market, not the model.

## 6. The model is VALIDATED, and the real bounded question is 167 editions

All Day, every edition with a sale in the last 30 days, grouped by the confidence it was assigned:

| confidence | editions | avg sales / 30 d | ≥5 sales | ≥10 sales |
|---|---:|---:|---:|---:|
| `HIGH` | 184 | **11.8** | **184 (100%)** | 113 |
| `MEDIUM` | 752 | **5.5** | 469 (62%) | 79 |
| `LOW` | 1,545 | **2.6** | 167 (11%) | 25 |
| `ASK_ONLY` | 8 | 2.5 | 1 | 0 |

**Confidence tracks trade volume monotonically, and cleanly.** Every HIGH edition has ≥5 sales; LOW averages
2.6. ⭐ **That is the finding that should change how the 30.1% is read: the accuracy gate is mostly a
LIQUIDITY CEILING, not an engineering defect.** Most editions on these platforms do not trade often enough
to support a confident price, and no amount of pipeline work changes that.

🎯 **The one genuinely bounded question left, and it is small enough to answer:** **167 LOW editions have ≥5
sales in 30 days and 25 have ≥10** — the same volume band where 469 MEDIUM and 184 HIGH editions sit. Volume
alone therefore does *not* decide confidence; something else demotes them (price dispersion, recency inside
the window, ask-vs-sale divergence). **Either those 167 are correctly LOW for a reason worth stating on the
surface, or they are the only editions on this platform where better modelling raises confidence without
inventing it.** That is a well-posed question against a 167-row population — unlike "improve accuracy".

⚠ **Still no recommendation.** §5 and §6 narrow *where* to look; they do not say what to do, and the answer
to §6 could legitimately be "they are correctly LOW". ⚠ Dated sample, 2026-08-23 22:15Z.
