# RPC community strategy — what it takes to actually get users on
2026-05-29 · read-only research follow-up

Companion to `wallet-deep-dive-and-pack-strategy-2026-05-29.md`. That doc found *what* to surface. This one tries to answer *who is the community*, *which surfaces will actually pull them in*, and *how to ship the first version in 4 weeks without paywall, without auth friction, and without competing head-on with Top Shot's own site.*

All numbers from production Supabase on 2026-05-29.

---

## 1. Who actually trades on Top Shot right now — the population shape

### TS wallets RPC has tracked (`wallet_moments_cache`)

| Cohort                  | Wallets | Moments held | Avg moments |
|---                     |---:    |---:          |---:         |
| 01 — mega whale 10k+    | 40      | 735,639      | 18,391       |
| 02 — whale 5k–10k       | 31      | 211,246      | 6,814        |
| 03 — collector 2k–5k    | 50      | 176,324      | 3,526        |
| 04 — active 500–2k      | 62      | 71,978       | 1,161        |
| 05 — engaged 100–500    | 32      | 9,171        | 287          |
| 06 — starter 25–100     | 8       | 475          | 59           |
| 07 — curious <25        | 11      | 108          | 10           |

234 wallets total. The 40+31+50 = **121 whales / collectors hold 90% of the tracked supply**.

**The growth target is rows 4 + 5 — the 94 "active" + "engaged" wallets in the 100–2,000 moment band, and the thousands of similar holders out there RPC has never seen.** Reasons:

- Whales already have private spreadsheets, group chats, and dealer relationships. They're not the customer for retail intelligence.
- The 100–2,000 cohort is the most underserved: too big to ignore the market, too small to build their own tools, most exposed to making one $500 mistake from bad info.
- This is also the cohort with the highest *content engagement* willingness — they read Twitter, they care about narratives, they'll click a "biggest sale of the day" tweet.
- The current bias in our tracked population (mostly whales/collectors) means **we are not currently visible to the cohort we want to serve.** That's the GTM problem to fix.

### Active sellers — the dealer concentration

30-day TS sales by seller wallet (≥20 sells/30d, $price > 0):

| Cohort         | Wallets | 30d GMV    | Avg sells/wallet |
|---            |---:    |---:        |---:               |
| pro 500+       | 2       | $478,969   | 15,152            |
| heavy 200–500  | 4       | $1,976     | 303               |
| active 100–200 | 11      | $14,635    | 142               |
| regular 50–100 | 31      | $13,110    | 70                |
| casual 20–50   | 98      | $35,037    | 30                |

**Two wallets** account for $479k of 30-day seller GMV — ~95% of active-trader volume. (One of them looks like a routing/treasury address — buyer-side is `NULL`/protocol-internal at 41,734 buys for $605k. Worth a separate trace before naming anything publicly.) Among *attributable* dealers, `0x8bf951fe6f7918b1` shows up at 122 sells / $5,429 — a real human dealer with a name we can put on a leaderboard.

The signal: a small number of high-velocity wallets drive a huge share of GMV. Publishing their patterns (without naming individuals defamatorily — just `0xabc…` truncation) is the kind of intelligence that fires up Twitter.

---

## 2. The "no other site tells you this" alpha surfaces

These are the differentiators I'd lead with — not because they're the most code, but because **Top Shot's own site structurally can't or won't ship them.**

### Surface A — Effective supply squeeze (lock-rate board)

Findings from `badge_editions`: across 3,012 TS editions with circulation data, **median lock rate is 38.6%, average 40.65%.** Burn rate runs ~10% on average. *On a typical Legendary edition, half the nominal supply is unavailable for sale right now because it's locked in a challenge.*

Specific squeeze examples:

| Player              | Set                            | Circ | Locked | Lock % | FMV     |
|---                 |---                             |---:  |---:    |---:    |---:     |
| Wembanyama          | Rookie Revelation (Legendary)  | 75   | 56     | 81.2%  | $3,420  |
| Caitlin Clark       | WNBA Rookie Debut 2024         | 1,250| 386    | 47.4% (+30% burned) | $294 |
| Aliyah Boston       | WNBA Metallic Gold LE 2023     | 93   | 68     | 74.7%  | $190    |
| Jalen Williams      | Rookie Revelation (Legendary)  | 75   | 52     | 71.2%  | $375    |
| Moses Malone        | Run It Back: 1970s (Rare)      | 299  | 195    | 68.9%  | $74     |
| Jamal Murray        | 2023 NBA Finals (Legendary)    | 75   | 49     | 67.1%  | $87     |
| Tre Johnson         | Freshman Gems (Rare)           | 164  | 96     | 65.3%  | $83     |
| Kon Knueppel        | Origins (Rare)                 | 164  | 96     | 63.2%  | $166    |
| Khaman Maluach      | Origins (Rare)                 | 164  | 89     | 60.5%  | $63     |
| Kevin Durant        | The Anthology (Legendary)      | 99   | 51     | 56.7%  | $503    |

The Wemby Rookie Revelation #1–75 is the headline: only 14 of 75 minted are actually available for sale. Origins (just-dropped rookie set: Knueppel, Maluach, Tre Johnson, Derik Queen) is averaging 60-65% locked — that's a supply story that hasn't fully propagated to price yet, and a clean "if you want one of these moments, the clock is ticking" angle.

**Product**: `/insights/squeeze` page. Sortable. "Lock + Burn % ≥ 60", refreshed nightly. **Headline metric the user sees:** "of [edition]'s minted supply, only [X] are actually purchasable" — not "circulation = Y" the way Top Shot displays it.

### Surface B — Rookie class index

The 2025 NBA rookie class is the most actively-traded narrative on TS right now. From 30d sales by player:

| Player              | Sales (30d) | Avg price | Max sale  | 30d GMV |
|---                 |---:         |---:       |---:       |---:    |
| Dylan Harper        | 80          | $267      | $3,512    | $21,360 |
| Kon Knueppel        | 42          | $392      | $3,007    | $16,454 |
| Cooper Flagg        | 36          | $426      | $1,950    | $15,328 |
| VJ Edgecombe        | 54          | $256      | $1,500    | $13,816 |
| Ace Bailey          | 52          | $143      | $1,111    | $7,437  |
| Jeremiah Fears      | 44          | $113      | $1,700    | $4,964  |
| Cedric Coward       | 52          | $95       | $795      | $4,938  |
| Collin Murray-Boyles| 43          | $113      | $493      | $4,857  |

Eight rookies, low sales count but **$89k of combined 30-day GMV at $100–$425 average price points**. This is whale + sharp-money speculation that the casual collector cohort wants visibility into but currently has to dig for one player at a time. Top Shot's site shows you a player page; *nobody* shows you the rookie class as a cohort.

**Product**: `/insights/rookies` index page — average $/moment, leaders by movement, by lock rate, by serial scarcity. Daily mover digest. Ties into a Twitter post template — *"Today's rookie movers: Harper $267 avg (+11%), Flagg #2/164 sold for $1,950..."*

### Surface C — Set momentum tracker

Set-level price change (30d avg vs prior 30d avg, min 30 sales each window):

| Set                       | Sales 30d | Sales prev | Avg price ∆ |
|---                       |---:        |---:        |---:         |
| With the Strip            | 38         | 30         | **+169.7%** |
| Denied!                   | 161        | 262        | **+108.1%** |
| Rise With Us              | 96         | 34         | +85.7%      |
| The Challenge: Champion   | 49         | 39         | +64.3%      |
| WNBA Fresh Gems           | 99         | 53         | +63.0%      |
| 2024 NBA Playoffs         | 89         | 143        | +63.0%      |
| Top Shot This             | 411        | 1,088      | +62.5%      |
| NBA Cup                   | 243        | 359        | +53.1%      |
| Top Script                | 30         | 95         | +45.1%      |
| WNBA Base Set             | 234        | 179        | +43.0%      |
| Mojo                      | 33         | 43         | +38.8%      |
| Season Tip-Off            | 170        | 88         | +34.1%      |
| Throwdowns                | 651        | 896        | +24.2%      |

Three things jump out:

1. **The Challenge: Champion +64% MoM** confirms the lock-squeeze story — moments locked into a challenge that's now resolving / about to resolve are rerating.
2. **WNBA is its own narrative** — Fresh Gems +63%, Base Set +43%, Rookie Debut 2025 +23%. Three different WNBA sets all positive. Combined with the Caitlin Clark / Aliyah Boston lock-rate data, this is a discrete trade RPC could own coverage of. Top Shot doesn't market WNBA as a category.
3. **Volume-weighted vs price-weighted** matters — "Denied!" sales went 262 → 161 *while* avg price doubled. That's not a fluke, that's holders pulling listings as price rises. Worth an "ask-side compression" callout per set.

**Product**: `/insights/sets/momentum` — heat-map of avg price MoM by set, with a "what's the story" one-liner per top mover. Daily snapshot pinned at the top of the page.

### Surface D — Pack EV with honesty (kill the 200x ratios)

From the prior research doc — `pack_ev_latest` is currently showing 222x value ratios on Rookie Revelation Quick Rip ($13 ask → $2,887 gross EV) because one stale-FMV Wembanyama Rookie Revelation Legendary is dragging the weighted average.

The fix is data discipline + UI honesty:

- **Confidence-weight the EV.** If 60% of pool moments are STALE/NO_DATA, surface that. Two columns: "EV (high-confidence pool only)" and "EV (full pool)".
- **Show the "chase contribution".** If 90% of the EV comes from one Legendary edition that's locked at 81%, label that. "$2,887 EV is 95% driven by Wemby RR #1–75 — and only 14 of those are actually available."
- **Switch the display from raw ratio to letter grades or a 5-point scale.** "A+ pack value, but high variance" beats "222x value ratio" in every honest comparison.

### Surface E — Reward-pack secondary premium board

Already covered in detail in the prior research doc (Fast Break runs trading $3 → $555 median for what are nominally identical templates). The data is in `pack_purchases` joined to `pack_distributions`; the UI is a per-Fast-Break-run page with a current ask-distribution chart and a 7-day trend.

This is the single most under-told mispricing story on Flow right now. People earn these for free and dump them blind because nobody publishes the secondary curve. **First-to-publish wins the user.**

### Surface F — The trophy sale ticker

Biggest single TS sales last 30 days:

| Player          | Set                  | Tier      | Serial | Price    | Date    |
|---             |---                   |---       |---:   |---:      |---     |
| Steph Curry     | Supernova            | ULTIMATE  | #9    | $10,000  | May 8   |
| Nikola Jokić    | Base Set             | COMMON    | #1    | $9,000   | May 9   |
| Steph Curry     | Holo MMXX            | LEGENDARY | #47   | $4,500   | May 3   |
| SGA             | Supernova            | ULTIMATE  | #1    | $4,100   | May 8   |
| Luka Dončić     | Cosmic               | LEGENDARY | #46   | $3,999   | May 3   |
| Hakeem Olajuwon | Supernova            | ULTIMATE  | #3    | $3,950   | May 19  |
| Dylan Harper    | Rookie Revelation    | LEGENDARY | #1    | $3,512   | May 9   |
| Luka Dončić     | Holo MMXX            | LEGENDARY | #3    | $3,400   | May 3   |
| Kon Knueppel    | Rookie Revelation    | LEGENDARY | #4    | $3,007   | May 6   |

Two stories beg coverage:

1. **The Supernova Ultimate ladder.** 3 of the top 20 sales were Supernova Ultimates ($10k, $4.1k, $3.95k). This is the new flagship Ultimate set; tracking every Supernova Ultimate sale is automatic content.
2. **The "Base Set #1" trophy thesis.** Jokić Base Set COMMON #1 went for $9,000 — that's a 5,000+ circulation Common that traded like a Legendary because it was *the first mint*. Pattern across collections. **A "First Mint Tracker" public page is one engineer-day of work and would be the kind of thing the trophy-hunter community shares to each other.**

---

## 3. The 4-week minimum lovable product

Goal: 50 weekly active users by end of June. Not "registered users" — *actual weekly returning visitors.* The framing memory enforces no-paywall, no-monetization talk until that bar is met.

### Week 1 — `/insights` public, no auth, OG-image-shareable

Three artifact pages, all rebuildable from existing data:

1. `/insights/squeeze` — top 25 lock-rate squeezes with effective-supply callout
2. `/insights/rookies` — 2025 rookie cohort, sortable
3. `/insights/trophies` — Ultimate sales + #1-serial sales feed

Each page must:

- Render without login (current `proxy.ts` lockdown breaks this — root `/` is private. **Add `/insights*` to the public-path bypass.**)
- Have a clean OG image (we already have `/api/og/*` routes — reuse and extend)
- Have a shareable URL the user can paste in a tweet and get a card preview
- Update at least daily via the existing cron pipeline

Engineering scope: under 3 days if we restrict to data we already have indexed.

### Week 2 — Reward-pack premium board + concierge portfolio fluency

1. `/insights/packs` — per-Fast-Break-run secondary curves + +EV ranking with confidence weighting (Surface D + E above)
2. Concierge hardening: add a `get_lock_rate_report(wallet)` tool to `/api/support-chat`. Anyone can type their 0x address and get an instant lock-squeeze + rookie-coverage + recent-mover report. **Concierge as the free demo.** This is the "no-login, no-friction try-it-now" hook.

### Week 3 — Distribution: Team Captain outreach

Trevor is one of ~30 Top Shot Team Captains. **This is the single highest-leverage distribution surface that exists for RPC.** Every Team Captain:

- Has 1–5k+ Twitter/X followers, almost all NBA/TS-specific
- Is publicly identified by Top Shot and credible
- Personally cares about analytics they don't have access to today
- Talks to each other in private TC chats — if 2-3 TCs share RPC, the rest will see it

Concrete week-3 plays:

1. Run a per-wallet lock-squeeze + rookie-coverage report for each TC wallet RPC can identify (the Blazers TC alone is already a customer — that's you). DM 10 TCs personally with their wallet's report and a "this is what I'm building" note.
2. Publish a `/team-captains/leaderboard` page comparing TCs' collection depth + market activity. Friendly competitive surface; TCs will share it.
3. The Blazers TC angle is the lead: "I'm a Team Captain. I built RPC because the analytics didn't exist. Here's my own portfolio under the hood." Public founder-portfolio page as proof.

### Week 4 — Iterate based on actual usage

By end of week 3 there should be enough log data to answer "of the things we shipped, what got clicked?" Cut whatever's not getting attention. Double down on whatever is. Build the first auto-post Twitter integration for the surface that won.

---

## 4. Distribution tactics that match the audience

### Twitter/X — the content treadmill

The collectibles community lives on Twitter. The bar for a daily artifact is low; the engagement is high. **One person can sustainably ship three pieces a day if the data is templated:**

- 9 AM ET — overnight Supernova Ultimate sale recap (or "biggest TS sale of the past 24h")
- 12 PM ET — daily squeeze board (the editions that crossed a new lock-rate threshold yesterday)
- 6 PM ET — daily rookie tape (which 2025 rookies moved the most $/% in the last 24h)

Each post links to the `/insights` page that generated it. Each `/insights` page has an OG card. Every share becomes a discovery surface.

Manual at first. Automate after week 3.

### Reddit — one weekly drop

`/r/NBATopShot` rewards effort + data; a single Tuesday morning post titled something like *"I built a lock-rate squeeze board — here's what's actually buyable on TS right now"* with screenshots + the public link, no signup wall, is the format that gets pinned. One per week. Don't spam.

### Discord — relationships > broadcast

Top Shot has multiple active Discords (the official TS Discord, the TC-only chats, the dealer / sharp-money group chats). The play here is **direct DM** to specific people you trust with specific reports you ran on their wallet, not broadcast posting.

### The Team Captain lever (worth saying twice)

The Blazers TC designation is a real moat. Every other TC has a private group chat with the others. If 3 TCs end up using RPC, you'll know within a week because every other TC will hear about it. This is the highest-leverage user-acquisition channel and it doesn't cost anything. Lead with it.

### The "give your wallet, get a report" public demo

The frictionless entry to RPC should be: paste your `0x` wallet, get an instant report. No signup, no auth, no email capture before the value. Concierge as the front door. Memory the result for 24h, prompt the user to bookmark RPC.

This converts way better than "sign up for our beta!" because there's nothing to sign up *to* — the user has already received value.

---

## 5. What NOT to do (with reasons)

### Don't try to be Flowty's replacement

Flowty shut down. The team is talking. Their use case (live in-app buy + loans + offers) isn't where RPC has product-market fit. Filling the Flowty hole would mean rebuilding the marketplace experience — which is exactly the thing Top Shot's own site does. Compete on *intelligence*, not *transaction surface*.

### Don't ship live buy

Already shelved per `intelligence-first-decision`. Reinforce: the outbound "View Listing →" reframe on Market/Sniper (May 23) was correct. Live buy is a $300k+ engineering investment with no obvious payoff vs Top Shot's own checkout. Skip.

### Don't go AllDay-first

AllDay's market is too thin (189 lifetime pack buyers vs TS's 4,929). Cover it, but every dollar of engineering goes further if pointed at the TS audience. AllDay deserves a *set tracker* / *completion-cost* tool — not a sniper.

### Don't promote unverified EV signals

The current `pack_ev_latest` 222x value ratios will burn trust the first time someone rips a "+EV" pack and gets a $4 common. Lead with confidence bands or letter grades, not raw ratios.

### Don't talk about monetization

The Pro paywall, Stripe, public launch — all tabled until 50 WAU per the existing decision. The product is currently in research-preview; positioning is "we're building intelligence the marketplace can't ship." Money question comes after traction, not before.

### Don't optimize for Trevor

Trevor's 14k-moment wallet is a useful *case study*, not the customer profile. Build features that work for the 100–500 moment holder, then surface Trevor's wallet as the "see what this looks like for a heavy collector" demo. The whale UX is a subset of the active-collector UX, not vice versa.

---

## 6. Specific community findings that drive the strategy

A handful of facts that should anchor every decision below:

- **40% of TS edition supply is locked on average.** Top Shot doesn't surface effective supply. RPC making this visible is a one-page change with structural value.
- **The Origins rookie set (Knueppel / Maluach / Tre Johnson / Derik Queen / VJ Edgecombe) is averaging 60-65% locked already.** This is the actively-trading rookie set right now and the supply story is mispriced.
- **WNBA is moving as its own narrative** (Fresh Gems +63%, Base Set +43%, Rookie Debut 2025 +23%). Caitlin Clark + Aliyah Boston anchor it. Worth a dedicated WNBA tab.
- **2 wallets drive ~95% of active-trader GMV.** Their identities are alpha (with caveats — one looks like a protocol address, needs tracing).
- **Pack on-chain volume 30x'd between weeks of April 13 and April 20.** The resurgence has a date. Content about that inflection writes itself.
- **The Supernova Ultimate ladder is the new flagship.** 3 of the top 20 TS sales last 30 days were Supernova Ultimates ($10k Curry, $4.1k SGA, $3.95k Hakeem).
- **The "first mint" trophy thesis is empirically real.** Jokić Base Set Common #1 sold for $9,000. Other collections show similar — #1 of any base set trades like a Legendary.

---

## 7. The 50-WAU question, framed concretely

50 weekly actives is roughly:

- 5 Team Captains using RPC once a week
- 10 sharp-money / dealer wallets returning for the lock-squeeze board
- 35 active-collector cohort users discovering the rookie index or pack premium board via Twitter

That's *achievable* if and only if:

1. The three `/insights` pages ship publicly with no auth wall (week 1)
2. Trevor personally outreach-DMs 10 TCs in week 3 with their own portfolio reports
3. Twitter cadence holds at 2-3 daily posts for 4 straight weeks
4. The concierge "paste your wallet, get a report" demo works from day one

If any of those breaks down, 50 WAU is unlikely. If all four hold, 50 WAU is conservative.

---

## 8. Open data issues this research turned up

For the active build threads:

1. **`cached_listings_v2` is empty for live TS** (0 active listings query). The topshot-listings-indexer was retired 2026-05-26. Several intelligence surfaces (effective floor, ask-side compression, listing-vs-FMV deal feed) depend on having live ask data. Rebuild via TS GQL polling — same path as the proxy, just for active listings.
2. **`sales.buyer_address` is NULL in 30d aggregation queries** — the top-buyer query returned a NULL wallet with 41k buys for $605k. Either Dapper's marketplace co-signer / treasury is mid-flow and getting recorded as buyer, or the buyer-resolution logic is dropping V1 Dapper rows. Worth tracing one tx through Flowscan to confirm.
3. **`distinct_buyers` is 0 on most sales tempo weeks** despite real buyers existing. Same root cause as above — buyer_address resolution gap on most rows.
4. **3,012 editions in `badge_editions` have circulation + burn + lock data** — that's a relatively low share of the full ~24k TS edition population. The other 21k are running without burn/lock signal, which limits the lock-squeeze board's coverage. Worth a backfill pass.
5. **Sales GMV declining May 11+** ($98k → $34k → $16k weekly) is almost certainly ingest lag — pack on-chain volume stayed elevated. Need to verify the indexers are still healthy after the listings-indexer retirement.

---

## Verification queries

All numbers from production Supabase `bxcqstmqfzmuolpuynti` on 2026-05-29. Key shapes:

```sql
-- Population cohorts
WITH ts AS (SELECT wallet_address, COUNT(*) m FROM wallet_moments_cache
            WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
            GROUP BY 1)
SELECT CASE WHEN m>=10000 THEN 'mega' WHEN m>=5000 THEN 'whale' WHEN m>=2000 THEN 'collector'
       WHEN m>=500 THEN 'active' WHEN m>=100 THEN 'engaged' ELSE 'small' END c, COUNT(*)
FROM ts GROUP BY 1;

-- Lock-rate squeeze board
SELECT player_name, set_name, circulation_count, burned, locked,
       burn_rate_pct, lock_rate_pct
FROM badge_editions
WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND (burn_rate_pct + lock_rate_pct) >= 60
ORDER BY (burn_rate_pct + lock_rate_pct) DESC LIMIT 25;

-- Set momentum
WITH win AS (
  SELECT e.set_name,
    AVG(s.price_usd) FILTER (WHERE s.sold_at >= NOW()-INTERVAL '30 days') a30,
    AVG(s.price_usd) FILTER (WHERE s.sold_at < NOW()-INTERVAL '30 days'
                              AND s.sold_at >= NOW()-INTERVAL '60 days') a60,
    COUNT(*) FILTER (WHERE s.sold_at >= NOW()-INTERVAL '30 days') s30,
    COUNT(*) FILTER (WHERE s.sold_at < NOW()-INTERVAL '30 days'
                      AND s.sold_at >= NOW()-INTERVAL '60 days') s60
  FROM sales s JOIN editions e ON e.id = s.edition_id
  WHERE s.collection='nba_top_shot' AND s.sold_at >= NOW()-INTERVAL '60 days'
    AND s.price_usd > 0 AND e.set_name IS NOT NULL
  GROUP BY 1)
SELECT set_name, ROUND(100.0*(a30-a60)/a60, 1) pct_chg
FROM win WHERE s30>=30 AND s60>=30 ORDER BY 2 DESC LIMIT 20;
```
