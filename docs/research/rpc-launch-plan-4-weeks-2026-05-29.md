# RPC 4-week launch plan — actionable, day-by-day
2026-05-29 · companion to the strategy + community docs

This is the concrete execution doc. Every action below has a specific deliverable, specific success metric, and the SQL or asset to run it. Pulls from real production data on 2026-05-29.

**The goal**: 50 weekly active visitors by end of June, primarily reached through Twitter content + Team Captain personal outreach, with three public no-auth intelligence pages doing the heavy lifting.

**The wedge**: three pieces of intelligence Top Shot's site structurally can't or won't ship.
1. Effective supply (lock + burn rate squeeze) — Surface A
2. Pack rip reality (median $0, mean $5.83) — Surface B
3. Rookie class cohort + first-mint trophy thesis — Surface C

**Headline numbers to lead with everywhere** (use these verbatim until they change):

- **51% of TS pack rips deliver $0 of pull value.** 127,867 rips audited over 60 days, median pull value $0, mean $5.83. Only 0.94% of rips deliver over $100.
- **Average TS edition has 40% of nominal supply locked in challenges.** Top Shot's marketplace displays circulation, not effective supply.
- **Jalen Brunson Run It Back: Origins is 95.4% locked.** 229 minted; only 12 are actually purchasable. FMV $850, ask $1,000.
- **The Got Game challenge nuked supply across the entire set.** Lonzo Ball / Harry Giles / Damion Lee / KCP all 67-77% burned with 50%+ lock on top.
- **First-mint serial #1 sells for 14-36x the average serial price** on Common-tier moments. Max observed multiplier: 194x (Jokić Base Set Common #1 → $9,000).
- **Kon Knueppel is the cleanest rookie thesis** right now: highest lock rate among the 2025 class (54.1%) AND highest avg price ($392).

---

## Week 1 (June 1-7) — Ship the three public pages, no auth

### Day 1-2 (Mon/Tue): Add `/insights*` to public-path bypass

Current `proxy.ts` requires auth on everything except `/login`, `/early-access`, `/api/*` etc. Add `/insights` to the public bypass list. ~1 hour of work.

Verification: open `/insights/squeeze` in an incognito browser. Should render without a login redirect.

### Day 2-4 (Tue-Thu): Ship `/insights/squeeze`

The widget I built above is a working visual mockup. Convert to a real Next.js route under `app/insights/squeeze/page.tsx`. Data source: `badge_editions` table — the query is in `docs/research/rpc-community-strategy-2026-05-29.md` §8. Refresh daily.

Five UX requirements:

- Filterable: All / 2023 rookies / WNBA / Metallic Gold LE / 2025 Playoffs / Extreme
- Sortable by squeeze %, lock %, FMV (default: squeeze % desc)
- Per-row click → moment detail page (deep link)
- Static OG image at `/api/og/insights/squeeze` — reuse existing OG infrastructure
- Single "Share this" button → opens Twitter intent with pre-filled text + page URL

Success metric: shareable URL works, OG card previews on Twitter.

### Day 4-5 (Thu-Fri): Ship `/insights/rookies`

Convert the Rookie Class Index widget. Data source: hardcoded 2025 draft player names (25 players above) → join `editions + sales + badge_editions`. Same daily refresh.

### Day 6 (Sat): Ship `/insights/pack-reality`

The pack honesty page. Three sections:

1. **The headline stat**: 51% of TS rips deliver $0.
2. **The distribution**: histogram of pull values (zero / $1-$10 / $10-$50 / $50-$100 / $100-$1k / $1k+).
3. **The list**: top 10 +EV packs on the marketplace right now WITH confidence bands and a "high-variance" flag where the EV is dragged by one stale-priced moment.

Data source: `pack_rips` for the histogram, `pack_ev_latest` for the list.

### Day 7 (Sun): Cross-link + Twitter card audit

Three pages live, cross-linked in the header nav. Each has a working OG card. Tweet a single launch post:

> RPC just shipped 3 public pages, no signup. Things Top Shot's site doesn't show you.
>
> /insights/squeeze — how locked the supply actually is. (Jalen Brunson RIB:Origins is 95% locked. 12 of 229.)
> /insights/rookies — the 2025 class as a cohort. (Knueppel: 54% locked, $392 avg.)
> /insights/pack-reality — half of TS pack rips deliver $0.
>
> rippackscity.com/insights

**Week 1 success metric**: 3 pages live, OG cards rendering, 1 launch tweet posted. Don't measure clicks yet — momentum matters more than analytics in week 1.

---

## Week 2 (June 8-14) — Distribution + concierge fluency

### Build the daily content engine

Three templated tweet types you should be able to write in 3 minutes from the data:

**A) Daily squeeze callout** (post ~9 AM ET):
> Today's effective-supply squeeze on Top Shot: [Player] [Set] [Tier]. [X] minted, [Y] actually available after lock + burn. FMV $[Z]. Top Shot shows you circulation. We show you effective supply. /insights/squeeze [link]

**B) Daily rookie tape** (post ~12 PM ET):
> 2025 rookie movers, last 24h: [Top 3 by % avg-price change]. Cohort 7-day lock-rate change: [up/down] [X]%. /insights/rookies [link]

**C) Daily trophy/big sale ticker** (post ~6 PM ET):
> Biggest TS sale today: [Player] [Set] #[serial] → $[amount]. Last comparable [edition] sale was [date] at $[amount]. [Insight or context.] [link to moment]

Run each manually for week 2. Don't automate yet — manual posts reveal which one resonates.

### Concierge as the demo

Add a one-tool concierge enhancement: `lookup_wallet_squeeze_exposure(0xwallet)` — returns the user's moments grouped by lock-rate bucket. Front-page CTA: *"Paste your wallet, see what's actually liquid in your bag."* Zero signup. The exposure of personal data only against your own wallet is the right scoping.

Success metric: front page → concierge → wallet pasted → report rendered. End-to-end, no friction.

### Ship Reward-Pack Premium Board

`/insights/packs/fast-break` — per-Fast-Break-run secondary curve from `pack_purchases` joined to `pack_distributions`. The data: Fast Break Run 12 ("4 Wins" reward, retail $0) is trading at $56 median, $555 max secondary. Run 10 at $3 median, $92 max. Same template, 18x apart.

Lead with the question: "You earned a Fast Break pack. Should you sell it?"

### Reddit drop (Tue June 10, 10 AM ET — high-traffic window)

Single post in `/r/NBATopShot` titled *"I built a lock-rate squeeze board — here's what's actually buyable on TS right now"*. Body: screenshot of the squeeze board, 3 bullet headlines (Brunson 95%, Wemby RR 81%, Got Game nuked), link. No marketing copy. Effort + data only.

**Week 2 success metrics**: 5 daily tweets posted, 1 Reddit post live, concierge wallet demo working.

---

## Week 3 (June 15-21) — Team Captain outreach

This is the highest-leverage week. Personal DMs to people who matter, with reports they actually want.

### Day 1 (Mon): Build the per-wallet TC report template

A one-page PDF (or screenshot-able web page) for any given wallet. Sections:
- Total collection: moments, editions, est FMV across collections
- Lock-rate exposure: % of held moments by squeeze bucket
- Rookie class coverage: how complete is the 2025 set
- WNBA coverage
- Recent acquisition timeline (last 90d notable buys)
- Set-completion progress on the 5 most-held sets

You can build this from existing `wmc + editions + fmv_snapshots + badge_editions` joins. It's a ~6 hour build.

### Day 2-4 (Tue-Thu): Run reports on 10 TC wallets

The 30 NBA Team Captain wallets are not on a public list, but you know most of them personally or can find them on Twitter / TS profiles. Pull their primary wallet addresses (most are public).

Run the report on each. **Personalize the DM.** Sample text:

> Hey [name] — I built RPC partly to scratch my own itch as Blazers TC. Ran your wallet through the analytics, attached the report.
>
> Couple things I noticed:
> - You're sitting on [X] moments in the [Set] squeeze zone — [Y]% of that set's effective supply is locked. Probably tighter than the marketplace UI suggests.
> - Your 2025 rookie coverage is [X]/[Y] — Knueppel and Harper are the locked-and-pricey corner.
> - [One more specific observation]
>
> Not selling anything — just wanted to share. If you find it useful, the same surfaces are public at rippackscity.com/insights.
>
> -Trevor

**Critical**: do not pitch. Do not ask them to share. Do not ask for feedback. *Just give value.* If 2 of 10 reply positively, the share comes naturally — TCs talk to each other.

### Day 5 (Fri): The "founder portfolio" public page

`/profile/jamesdillonbond` already exists. Restructure as an opinionated case study. Sections:
- "My bag, with confidence bands" — the 14k TS / 3.7k AllDay / $66k FMV breakdown with HIGH/MEDIUM/LOW counts visible (89% LOW/STALE — lean in)
- "My 20 #1 / 1 trophies" — display the actual #1 serials, Donovan Clingan 2024 Rookie Ultimates etc.
- "Things I'm wrong about" — annotated picks that didn't work (showing fallibility builds trust)
- "What I'm watching" — current squeeze plays, rookie picks
- "I'm a Team Captain. Here's everything I see." — the credibility line

Promote it once on Twitter, link to `/insights` from inside it.

### Day 6-7 (Sat-Sun): Concierge stress test + Discord direct relationships

Have 2-3 friends paste their wallet into the concierge. Watch what breaks. Patch the rough edges. Direct-message 3-5 active TS Discord users you trust personally with their wallet report.

**Week 3 success metrics**:
- 10 personalized TC outreach DMs sent
- At least 2 TC replies
- Founder portfolio page live + posted once
- 5+ wallet reports run via concierge

---

## Week 4 (June 22-28) — Measure, cut, double down

### Day 1 (Mon): Pull the usage data

What's the click distribution across `/insights/{squeeze, rookies, pack-reality, packs/fast-break}` over the prior 3 weeks? Which Twitter posts drove the most landing-page visits? (Vercel analytics + manual referrer tracking is fine — don't over-engineer.)

### Day 2-3 (Tue-Wed): Cut what didn't work

If `/insights/pack-reality` outperformed the other two by 3x — make pack reality the front page. If a specific tweet template went viral while the others didn't — write that template every day instead of variety. *Be ruthless about cutting.*

### Day 4-5 (Thu-Fri): The "second wave"

Build one new surface based on what worked. Candidates:

- **Completed Challenge Burn Report** — the Got Game set was 67-77% burned. Publish the full set with the post-mortem.
- **First-Mint Trophy Tracker** — every #1 serial sale of the last 90 days, with the multiplier vs avg serial.
- **Cross-Collection Whale Map** — the 142 wallets that hold 3+ Flow collections, with their cross-collection footprint.
- **Pack EV with Confidence Bands** — the existing pack EV ranker, but tagged "high variance" where the EV is dragged by one moment.

Pick one. Ship it Friday.

### Day 6-7 (Sat-Sun): Reflect + plan the next 4 weeks

If you've crossed 50 WAU, the next conversation is about Pro paywall + Stripe. If you're at 20 WAU, the next conversation is "what specific friction is preventing the next 30 — content, distribution, or product?"

**Week 4 success metric**: ≥50 weekly active visitors. Honest measurement, no vanity metrics.

---

## Content templates ready to use (verbatim drafts)

### Tweet — squeeze board launch

> Top Shot displays circulation. We display effective supply.
>
> Jalen Brunson Run It Back: Origins → 229 minted, 209 locked. **12 actually available**. The marketplace floor is much tighter than the listing page shows.
>
> Built the squeeze board: rippackscity.com/insights/squeeze
>
> Free. No signup.

### Tweet — pack reality

> I ran the math on every Top Shot pack ripped in the last 60 days.
>
> 127,867 rips. Average pull value: **$5.83**. Median: **$0.00**.
>
> Half of all packs delivered nothing. 1% delivered over $100.
>
> Honest pack ranker → rippackscity.com/insights/pack-reality

### Tweet — rookie index

> The 2025 NBA rookie class on Top Shot, ranked by 30d GMV + lock-rate.
>
> Top mover: Dylan Harper ($21k GMV)
> Highest lock+price combo: Kon Knueppel (54% locked, $392 avg)
> Biggest single sale: Harper Rookie Revelation #1 → $3,512
>
> Live index: rippackscity.com/insights/rookies

### Tweet — first mint thesis

> The "first mint" trophy thesis is real and quantifiable.
>
> On TS Common moments, serial #1 typically sells for **14-36x the average serial price**. Outliers go up to 194x.
>
> Nikola Jokić Base Set Common #1 just sold for $9,000. Average other-serial sale of that edition: ~$5.
>
> Trophies aren't a vibe. They're a math.

### TC outreach DM (already written, see Week 3)

### Reddit post template (NBATopShot weekly)

> Title: I built a lock-rate squeeze board for Top Shot — here's what's actually buyable
>
> Body: I'm Trevor, Blazers Team Captain. Got annoyed that the TS marketplace shows "circulation: 199" when 73% of it is locked in a challenge and untouchable. So I built a board that shows effective supply.
>
> Findings:
> - Jalen Brunson Run It Back: Origins → 12 of 229 available
> - Wemby Rookie Revelation Legendary → 14 of 75
> - 2025 Playoffs Legendaries → 21 of 75 (Luguentz Dort)
> - The 2023 rookie class Freshman Gems set: every member is 90%+ locked or burned
>
> [Screenshot of squeeze board]
>
> Public, no signup: rippackscity.com/insights/squeeze
>
> Happy to take feedback. What would you want to see next?

---

## Things to deliberately NOT do this month

- Don't add new login flows or signup pages
- Don't talk about Pro / paywall / Stripe
- Don't try to build the wallet-connect / in-app buy
- Don't optimize for whale users — the surfaces above all serve the 100-2,000 moment cohort
- Don't measure anything besides "did someone come back" and "did someone share"
- Don't ship more than one new surface per week
- Don't compete with Flowty's old product — they're dead anyway

---

## Long-tail observations from the second data pass

For the active build threads to pick up after this month:

1. **`buyer_address` resolution gap is blocking smart-money analytics.** Most TS sales have NULL `buyer_address`. The same fetchTxBuyers pattern that AllDay uses (proposer/authorizer/payer minus excluded addresses) needs to be applied to TS V1 sales. Without this, the net-buyer leaderboard can't be published.
2. **`pack_rips.dist_id` only resolves for ~25% of rips.** The `backfill_pack_rip_metadata` cron is making progress but slowly. Worth a one-time bulk backfill before publishing "pack ROI by drop" analysis — currently 22,090 of 22,090 60-day rips have NULL `contemporaneous_pack_price` because of this.
3. **`badge_editions.low_ask` is healthy on TS (86%) but 0% on AllDay and 5% on Golazos.** Cross-collection completion-cost calculator would benefit from filling this in.
4. **The Got Game challenge "burn nuke" pattern is a one-time event** — publish the post-mortem before the data is forgotten. Lonzo / KCP / Damion Lee / Harry Giles all 67-77% burned in a recent challenge.
5. **`pack_distributions.metadata->>'retail_price_usd'` is mixed-format** ($0, $9, "2900000000" satoshi). Normalize before exposing on a public page or the casual reader will see "$2.9B retail" on a pack card.

---

## The single most important rule for this month

If a feature, a tweet, or an outreach DM doesn't pass this test, don't ship it:

> Would a 500-moment Top Shot holder who has never heard of Rip Packs City find this concretely useful within 30 seconds of seeing it?

That's the customer. Everything else is noise.
