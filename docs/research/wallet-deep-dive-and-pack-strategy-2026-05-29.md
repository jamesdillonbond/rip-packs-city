# Wallet deep dive + Top Shot pack on-chain strategy — 2026-05-29

Read-only research pass. No code changes. All numbers pulled live from production Supabase `bxcqstmqfzmuolpuynti` on 2026-05-29.

Wallet under audit: **`0xbd94cade097e50ac`** (jamesdillonbond, Trevor).

---

## 1. Wallet footprint at a glance

| Collection      | Moments | Unique editions | FMV total (latest)        | Notes                            |
|---             |---:    |---:             |---:                       |---                               |
| NBA Top Shot    | 14,274  | 5,844           | **$66,199**                | 88% of moments priced LOW/STALE/NO_DATA |
| NFL All Day     | 3,705   | 2,152           | **$8,793**                 | 91% LOW; 100% have *some* FMV    |
| UFC Strike      | 247     | (0 mapped)      | n/a                        | wmc → editions mapping gap       |
| Disney Pinnacle | 181     | 63              | (separate FMV table)       | 27 distinct characters           |
| LaLiga Golazos  | 44      | 44              | n/a (collection thin)      | Only tracked Golazos wallet      |
| **TOTAL**       | **18,451** | —            | **~$75k+ in TS+AllDay alone** | UFC/Pinnacle/Golazos add tail    |

Rank inside RPC's tracked-wallet population (NOT all of Flow — RPC currently tracks 234 TS / 196 AllDay / 106 UFC / 128 Pinnacle / 1 Golazos wallets in `wallet_moments_cache`):

- TS: #20 of 234 (top 8.6%)
- AllDay: #25 of 196 (top 12.8%)
- UFC: #4 of 106 (top 3.8%)
- Pinnacle: #21 of 128 (top 16.4%)
- Golazos: #1 of 1

> Caveat: this is a comparison against wallets RPC has *seen*, not the full Flow population. Treat as directional, not absolute.

---

## 2. Top Shot — quality of the bag

### Tier mix (14,274 moments)

| Tier         | Moments | Unique editions |
|---          |---:    |---:             |
| COMMON       | 11,225  | 4,042           |
| (null tier)  | 1,379   | 1,114           |
| RARE         | 1,281   | 1,128           |
| FANDOM       | 306     | 242             |
| LEGENDARY    | 81      | 68              |
| ULTIMATE     | 2       | 2               |

Heavy Common skew is expected for a 14k-deep bag; the Legendary/Ultimate count is where the dollar value concentrates.

### FMV confidence reality (held-moment-weighted)

| Confidence | TS moments | AllDay moments |
|---        |---:        |---:            |
| HIGH       | 300        | 66             |
| MEDIUM     | 1,331      | 265            |
| LOW        | 10,804     | 3,372          |
| STALE      | 242        | 2              |
| NO_DATA    | 1,447      | 0              |

**Headline number to internalize: only ~11% of TS moments (HIGH + MEDIUM) carry a confident FMV. The other 89% lean on a single stale comp or no comp at all.** This is not a bug in RPC's pipeline — it's the truth about Top Shot's long tail. Top Shot's own site hides this by displaying last-sale-price as if it's a live mark. *RPC's confidence taxonomy is a differentiator if we lean into it on the front end.*

### Serial quality

| Bucket       | Moments |
|---          |---:    |
| #1 / 1      | 20      |
| top 10      | 53      |
| top 1%      | 195     |
| top 5%      | 874     |
| top 10%     | 778     |
| last mint   | 10      |
| top half    | 5,670   |
| bottom half | 6,622   |

About 13% of the bag is in the top-10% serial slice. 20 #1/1s, including the Donovan Clingan 2024 Rookie Ultimates #1 ($2,100 STALE) — that's a real trophy-grade asset.

### Top 10 dollar concentrations

| Player              | Set                       | Tier      | Serial | FMV (latest) | Confidence |
|---                 |---                        |---       |---:   |---:          |---         |
| Zion Williamson     | Holo MMXX                 | LEGENDARY | #29   | $3,018       | STALE      |
| Damian Lillard      | Cosmic                    | LEGENDARY | #38   | $2,666       | STALE      |
| Donovan Clingan     | 2024 Rookie Ultimates     | (null)   | #1    | $2,100       | STALE      |
| James Harden        | Holo MMXX                 | LEGENDARY | #30   | $1,261       | STALE      |
| VJ Edgecombe        | Origins                   | (null)   | #13   | $1,104       | LOW        |
| Victor Wembanyama   | Metallic Gold LE          | (null)   | #44   | $950         | STALE      |
| Deni Avdija         | Kingmaker                 | (null)   | #1    | $800         | STALE      |
| Andre Drummond (x2) | Holo MMXX                 | LEGENDARY | from #14 | $343 each | STALE      |
| LeBron James        | Metallic Gold LE          | RARE      | #258  | $616         | STALE      |
| Team Moment         | 2022-23 Season Rewind     | COMMON    | #33   | $605         | STALE      |

Pattern: high-value bag is Legendary Holo MMXX + low-serial Metallic Gold LE + Blazers (Dame Cosmic, Clingan #1, Avdija #1). Lines up with the Team Captain identity.

Almost every top dollar line is **STALE** — i.e. no comp in 60+ days. The implied $66k FMV total has a wide error bar; the *real* mark-to-market is probably 30-50% softer for the Legendary Holo MMXX / Metallic Gold sleeve, and possibly stronger on the rookie-#1 trophies (which trade by appointment, not by feed).

### Set concentration (top 20 sets in the wallet)

Top of the list: **Base Set (5,907 held, 1,860 unique editions), Base Set6 (1,032), Archive Set (835), Rookie Debut (707), Rookie Debut6 (480), Metallic Gold LE (440), Spotlight Series (382), Fresh Threads (283), Hustle and Show (235), WNBA 2024 (225)**.

The Metallic Gold LE line — 440 moments across 391 unique editions — is the most interesting strategic concentration. That set has been the engine of TS's last 12 months of growth and the 391-unique footprint suggests deliberate completion-style buying, not flips.

---

## 3. NFL All Day — completionist tells

3,705 moments / 2,152 unique editions / **$8,793 FMV**.

Tier mix is more compressed than TS — predominantly COMMON + RARE with a handful of LEGENDARY anchors.

Top 10 holdings:

| Player              | Set                          | Tier      | Held | Lowest serial | FMV (latest) |
|---                 |---                           |---       |---:  |---:            |---:         |
| Amon-Ra St. Brown   | Rookie Revelation            | LEGENDARY | 1    | #44            | $450        |
| Tom Brady           | Base                         | COMMON    | 1    | #8,106         | $266        |
| DeVonta Smith       | Base                         | COMMON    | 1    | #9,976         | $222        |
| Joe Burrow          | Super Wild Card Weekend      | RARE      | 1    | #829           | $198        |
| Calvin Johnson      | Lions Vintage                | LEGENDARY | 1    | #31            | $150        |
| Austin Ekeler       | Locked In                    | RARE      | 1    | #804           | $122        |
| Rodney Harrison     | Playoff Game Changers        | RARE      | 1    | #286           | $115        |
| Brett Favre (x2)    | Opening Acts                 | COMMON    | 2    | from #896      | $102 each   |
| Puka Nacua          | 2023 Rookies                 | RARE      | 1    | #13            | $92         |
| Aidan Hutchinson (x2) | Draw it Up                 | RARE      | 2    | from #58       | $48 each    |

**Completionist tell**: 12x Terrion Arnold Regal Rookies, 9x Jerick McKinnon Gridiron, 5x Michael Penix Jr. Rookie Debut, 4x Brian Branch 2023 Rookies. That's bulk-buying behavior, not collector behavior — strong signal that AllDay's main product opportunity for someone with Trevor's profile is *set completion tooling* rather than sniper. The AllDay secondary market is too thin for sniper to be the right hammer here (1,200 secondary pack sales all-time across ~189 buyers — see §5).

---

## 4. Pack history — Trevor's own ledger

### Pack purchases (lifetime, this wallet)

| Collection | Event kind         | Primary? | Packs | Distinct | Avg price | Total spend |
|---         |---                 |---       |---:  |---:      |---:       |---:         |
| TS         | primary_withdraw   | true     | 15   | 15       | —         | (free/claim)|
| TS         | secondary_sale     | false    | 25   | 25       | $11.04    | $276        |
| AllDay     | secondary_sale     | false    | 1    | 1        | $1.00     | $1          |

15 primary TS withdraws (all reward/quest packs, hence $0 price field) + 25 secondary buys at modest $11 median + 1 throwaway AllDay flip. First buy: 2026-04-15. Most recent: 2026-05-30 01:09 UTC.

### Pack rips (this wallet)

- 30 TS rips total
- $183 total pull value
- **~$6.11 avg pull per pack ripped**
- Only 4 of 30 rips resolved a `dist_id` (consistent with the platform's known dist-resolution gap on legacy rips)
- Net: out of 40 packs bought (15 primary + 25 secondary, $276 spend), 30 were ripped for $183 of pull value. ~67% realized return on the *opened* portion, and 10 packs are still held.

The rip ledger is mostly small reward packs delivering small commons — exactly what the secondary-pack data in §5 predicts (median secondary price on the dominant Fast Break reward packs is $3-$56; you cannot rip a $3 reward pack into a sustainable +EV trade).

---

## 5. Top Shot packs are absolutely back on chain — confirmed

This was the biggest finding of the session. The hypothesis is correct, the inflection is sharp, and it has a date.

### TS pack tempo by week (last 8 weeks)

| Week of    | Primary packs | Secondary packs | Distinct buyers |
|---         |---:           |---:             |---:              |
| 2026-04-06 | **0**         | 1,378           | 513              |
| 2026-04-13 | 1,121         | 7,149           | 1,305            |
| 2026-04-20 | **14,341**    | 6,159           | 1,723            |
| 2026-04-27 | 16,784        | 4,667           | 1,891            |
| 2026-05-04 | 19,566        | 3,874           | **2,863**        |
| 2026-05-11 | 9,928         | 2,628           | 1,340            |
| 2026-05-18 | **31,797**    | 4,256           | 2,483            |
| 2026-05-25 | 8,085         | 2,623           | 1,418            |

**Inflection date: week of 2026-04-13 → 2026-04-20.** Primary pack volume went from 1,121 → 14,341 (12x) in one week and has stayed elevated. Lifetime totals in `pack_purchases`: 134,356 TS pack events, 101,622 primary + 32,734 secondary, **4,929 distinct buyers**. NFL All Day over the same window is essentially flat: 1,613 total events, 189 distinct buyers — *the resurgence is a Top Shot story, not a Dapper-wide story.*

### Where the secondary pack money is

Last 30 days, by `dist_id`, ranked by sales:

| Dist  | Title                                                | Tier   | Retail | Sec sales | Median | Max  |
|---:   |---                                                   |---    |---:    |---:       |---:    |---:  |
| 7800  | Fast Break - 25-26' Classic Run 12 - 4 Wins Pack     | common | $0     | 407       | $56    | $555 |
| 7672  | Fast Break - 25-26' Classic Run 10 - 4 Wins Pack     | common | $0     | 101       | $3     | $92  |
| 5048  | For The Win & Denied!: Chance Hit                    | common | $9     | 72        | $5     | $34  |
| 6452  | Fast Break - 25-26' Classic Run 3 - 4 Wins Pack      | common | $0     | 48        | $30    | $40  |
| 5915  | Run It Back: 1970s Chance Hit Pack (Wave 3)          | common | $5     | 44        | $4     | $7   |
| 7728  | Chase Cooper Flagg and Kon Knueppel Rookies          | common | $0     | 40        | $3     | $150 |
| 7675  | Fast Break - 25-26' Classic Run 11 - 4 Wins Pack     | common | $0     | 32        | $33    | $45  |
| 7584  | Courtside: Chance Hit                                | common | $5     | 24        | $50    | $115 |
| 7358  | Rookies and Stars: Debuts Through Time               | common | $9     | 17        | $99    | $358 |
| 1764  | (Legendary $499 retail)                              | legendary | $499 | 15      | $2     | $2   |

Two stories jump out:

1. **Fast Break reward packs are the dominant secondary instrument.** Five of the top ten dist_ids by 30d secondary volume are Fast Break "4 Wins" reward packs (retail $0). The market hasn't decided what they're worth — Run 12 trades at $56 median ($555 ceiling), Run 10 trades at $3 median, Run 11 at $33, Run 3 at $30. *That spread is the product opportunity.* People are getting these for free and selling them blind; buyers don't know what they're priced for.
2. **There are pack carcasses sitting in the marketplace.** Dist 1764 — a Legendary $499 retail pack — has 15 secondary sales in 30 days at exactly $2 each. That's the "I just want this out of storage" trade. Same pattern on dist 1018 (Throwdowns January, $29 retail → median $2 secondary).

### Live +EV packs sitting on the marketplace (snapshot ≤7 days old)

Pulled from `pack_ev_latest` where `is_positive_ev = true`:

| Dist  | Pack                                          | Ask    | Gross EV | Pack EV  | Ratio   | Unopened |
|---:   |---                                            |---:   |---:      |---:      |---:     |---:      |
| 1206  | Rookie Revelation Quick Rip                   | $13    | $2,887   | $2,874   | **222x**| 1,264    |
| 6033  | Anthology: Chance Hit                         | $8     | $1,806   | $1,798   | **226x**| 555      |
| 5257  | First Round Rewind: Chance Hit                | $17    | $1,170   | $1,153   | 68x     | 86       |
| 1205  | Rookie Revelation 2023-24                     | $875   | $1,886   | $1,011   | 2.2x    | 138      |
| 4133  | November 7th, 2024 Premium Pack               | $39    | $893     | $854     | 23x     | 71       |
| 5261  | First Round: Chance Hit                       | $21    | $473     | $452     | 23x     | 94       |
| 5748  | WNBA Signature Hunt Chance Hit                | $44    | $458     | $414     | 10x     | 325      |
| 5236  | First Round Rewind: Chance Hit                | $21    | $396     | $375     | 19x     | 96       |
| 474   | Premium Pack (Series 1, Drop 2, Wave 3/5)     | $774   | $1,148   | $374     | 1.5x    | 211      |
| 5180  | Chasing Holo Icon: Chance Hit                 | $30    | $400     | $370     | 13x     | 60       |
| 3873  | Arcade Pack - Happy Birthday Top Shot         | $5     | $221     | $216     | 44x     | 1,577    |

**Caveat that needs surfacing in the product**: 200x+ ratios almost certainly mean a single ultra-rare moment in the pool with stale FMV is dragging the weighted EV. The directional opportunity is real, but the headline number shouldn't be taken at face value without a confidence band. Worth treating these as "ranking, not pricing" until the underlying FMV freshness is solved.

### Top secondary pack flippers (last 30d)

| Wallet                | Secondary packs bought (30d) |
|---                   |---:                          |
| 0xf77bf547fccf6656    | 404                          |
| 0x10725d006b1a680e    | 377                          |
| 0x646346cc527073d1    | 333                          |
| 0x50d85428ef85cb1d    | 328                          |
| 0x52c128c336de6895    | 235                          |
| 0x9139bb1a42df770b    | 232                          |
| 0xe86297c1906df37d    | 196                          |
| 0xad1f4477244aba3b    | 191                          |
| 0x35873ed90cebb570    | 190                          |
| 0x3691693414f2daba    | 189                          |

10 wallets account for ~2,475 secondary pack buys in 30 days. These are professional pack flippers / arbitrage desks — public-figure transparency on this cohort is a product surface in itself.

---

## 6. Pack-product opportunities for RPC

Ranked by leverage relative to "intelligence beyond what nbatopshot.com gives you":

### A. Reward-pack premium tracker (highest-leverage, lowest-lift)

The Fast Break reward-pack market is the single most mispriced surface on Flow right now. Hundreds of people earn these for free and dump them blind on secondary; the bid/ask range is $1 → $555 on the same pack template.

Build: a per-Fast-Break-run page showing realized secondary distribution (median, P25/P75, max, sales count, last 7d trend) **plus** the recommended ask range based on contents distribution. This is intelligence Top Shot literally can not show because they don't surface the secondary market.

### B. Pack flipper leaderboard (transparency = traffic)

Publish the top 50 pack-secondary buyers + sellers by 7/30/90 day windows, with net flow. Power buyers in this market are unknown to most users. This is the same play that worked for Flowty's "top sellers" view but applied to packs. Plays well with concierge — "what's the smart money buying this week?" type query.

### C. Pack-EV ranking with confidence bands

`pack_ev_latest` already has the data; the front-end just needs to show:

- Pack ask
- Weighted gross EV
- **Confidence on that EV** (right now a 222x ratio is meaningless because one stale-priced rookie #1 is pulling the average)
- "Best case if you hit the chase" vs "expected pull"
- Total unopened (depletion-pct context)

The honesty story here is the wedge. Top Shot's pack store does not surface expected pull value at all.

### D. Primary drop calendar with realized buyer counts

The TS resurgence had a date (April 13 → April 20). Most users do not know which drops drew 2,800 buyers vs 300. A weekly drop digest — "this week's drop attracted X distinct buyers, depleted Y% by W hours" — is light to build (the `pack_distributions` + `pack_purchases` data is already there) and is something only RPC can surface.

### E. Pack carcass index (deal finder)

Legendary retail-$499 packs trading at $2 is a pull-value-cost arbitrage AS LONG AS the pull-value-cost ratio is positive. RPC already has the EV signal — package this as "Pack Bargains: packs trading below 25% of historical EV" and put it in front of users who like ripping. Honest framing: this is gambling intel, not a discount.

### F. Pack lifecycle tracker (deeper play)

`get_pack_lifecycle(p_pack_nft_id)` already exists. Surfacing it — every pack as a clickable timeline (minted → resold → resold → opened → moments delivered → wallets the moments ended up in) — is the kind of receipt-grade transparency that builds RPC's "intelligence-first" brand and would not be feasible on a marketplace's own site (conflicts of interest).

---

## 7. Broader RPC strategy notes

Given the intelligence-first commitment and the "no paywall until 50 WAU" framing from memory, three lanes:

### Lane 1 — Make the intelligence visible

The 89% LOW/STALE/NO_DATA reality on TS is RPC's biggest differentiator and also its biggest under-marketed asset. Top Shot's site presents last-sale-price as gospel. RPC publishes confidence honestly. Every moment page should put confidence next to FMV. The current UI hides it in a chip; it should be a primary affordance: "$3,018 (STALE — last comp 60+ days ago, low confidence)". That single change converts a perceived weakness into the product's most credible signal.

### Lane 2 — The founder wallet as proof

Trevor's wallet is a credible artifact: 14k+ TS moments, $66k FMV, top 9% of tracked wallets, Blazers Team Captain, real holdings in Holo MMXX / Cosmic / 2024 Rookie Ultimates #1. A public "founder portfolio" page (already there at `/profile/jamesdillonbond`) used as a *case study* — annotated picks, ripping history, set completion progress, candid commentary on which pack pulls hit and which didn't — is the kind of authentic content that a marketplace cannot produce. It's a content moat, not a code moat.

### Lane 3 — Where to put the next 4 weeks of engineering effort

Given the pack data above and the open items in CLAUDE.md:

1. Ship the reward-pack premium tracker (Section 6A) — highest leverage, smallest new surface area, directly leverages existing data.
2. Ship a confidence-first FMV affordance — frontend-only change, biggest brand differentiation per hour of work.
3. Tune the pack EV display to show a confidence band, not a 200x value ratio — honesty discipline, prevents future "RPC said this was +EV and I lost $40" complaints.
4. Then keep grinding the FMV-recalc throughput (the open lever in CLAUDE.md's "FMV HIGH-confidence lever is throughput") to actually move the 89% number.

What to *not* do based on this research:

- Do not bias toward AllDay sniper. AllDay's secondary pack market is 189 buyers all-time vs 4,929 on TS; the marketplace is too thin to be a sniper hammer. AllDay deserves a set-tracker / completion-cost / bulk-position UI instead.
- Do not chase the "in-app live buy" path further. The secondary market for TS packs is on Top Shot's own marketplace; the value RPC adds is the *intelligence* before the click, not the click itself. The May 23 reframe to outbound links was correct.
- Do not promote pack EV as "guaranteed profit" — even the live +EV ranking has stale-FMV outliers driving the numbers. Lead with EV *ranking* and back it with confidence bands.

---

## 8. Open data quality gaps surfaced

These came up while running the audit; flagging for the active build threads:

1. **`pack_purchases.pack_dist_id` is NULL on all primary_withdraw TS rows.** Per CLAUDE.md this is by design (resolves on open via `pack_rips`), but it makes the `distinct_dists` column in the primary tempo query useless. Worth an alternate primary-tempo view that joins through `pack_rips`.
2. **`pack_distributions.metadata.retail_price_usd` mixes formats** — `"0"`, `"9"`, `"2900000000"` (= $29 in satoshi), `"2000000000"` (= $20). The query has to coerce. Worth normalizing once in DB.
3. **`pack_distributions.total_minted` / `total_opened` / `depletion_pct` are all 0 across the 134k pack-purchases sample.** Either these columns aren't being maintained or they need a backfill. Big miss for the pack-EV depletion story.
4. **wmc → editions mapping is empty for UFC** (247 moments, 0 unique editions matched). Known issue.
5. **`pack_ev_latest.gross_ev` shows 200x+ ratios** because one rare moment with stale FMV dominates the weighted average. Needs a per-edition FMV-confidence weighting on the EV computation, or at minimum a "high-variance" flag on the snapshot.

---

## Appendix — verification queries

All numbers in this report were generated via `mcp__supabase__execute_sql` against project `bxcqstmqfzmuolpuynti` on 2026-05-29. Key queries:

```sql
-- Inventory by collection
SELECT c.slug, COUNT(*), COUNT(DISTINCT edition_key)
FROM wallet_moments_cache wmc JOIN collections c ON c.id = wmc.collection_id
WHERE wmc.wallet_address = '0xbd94cade097e50ac' GROUP BY 1;

-- TS pack tempo
SELECT date_trunc('week', sealed_at)::date AS wk, event_kind, COUNT(*)
FROM pack_purchases
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND sealed_at >= NOW() - INTERVAL '90 days'
GROUP BY wk, event_kind ORDER BY wk DESC;

-- Live +EV packs (use snapshotted_at to filter freshness)
SELECT dist_id, pack_name, pack_price, gross_ev, pack_ev, value_ratio
FROM pack_ev_latest
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND is_positive_ev = true
  AND snapshotted_at >= NOW() - INTERVAL '7 days'
ORDER BY pack_ev DESC LIMIT 25;

-- Secondary pack market intelligence
SELECT pack_dist_id, COUNT(*), MIN(sale_price), AVG(sale_price), MAX(sale_price)
FROM pack_purchases
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND event_kind = 'secondary_sale'
  AND sealed_at >= NOW() - INTERVAL '30 days'
GROUP BY pack_dist_id ORDER BY COUNT(*) DESC LIMIT 25;
```

Cross-check on Flowscan if you want to spot-check any individual tx: most pack events live under contract `A.0b2a3299cc857e29.PackNFT` (Top Shot) or `A.e4cf4bdc1751c65d.PackNFT` (NFL All Day). Secondary pack listings flow through `A.4eb8a10cb9f87357.NFTStorefrontV2` (the Dapper storefront, NOT the dormant Flowty fork).
