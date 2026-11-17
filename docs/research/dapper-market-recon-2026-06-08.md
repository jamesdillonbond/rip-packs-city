# dapper.market recon — 2026-06-08

Live crawl of https://dapper.market/ (Chrome, logged into Trevor's Dapper account). This is **Dapper Labs' own in-house secondary marketplace** — the thing that replaced Flowty. It quietly answers the biggest open question hanging over RPC since the 2026-05-13 Flowty shutdown: *where does Top Shot / All Day / Golazos secondary trading happen now?* Answer: here.

---

## TL;DR — the five things that matter

1. **This is the post-Flowty marketplace, and it's Dapper's.** Flowty is dead; Dapper brought the order book in-house at dapper.market. The native marketplaces (nbatopshot.com/search etc.) are still live and separate, so the move is to **add a dapper.market link alongside the existing native link** — dapper.market fills the UI slot RPC used to give Flowty (a second buy option), not a replacement of native. Highest-value, lowest-risk action from this crawl. Handoff: `docs/handoff-2026-06-08-dapper-market-outbound-links.md`.
2. **It's a transaction layer, not an intelligence layer.** It has buy/sell, a serial-level order book, "Avg Sale," and basic 30/90-day volume stats. It has **none** of RPC's intelligence: no FMV confidence, no squeeze/lock analytics, no pack EV, no deal/discount scoring, no cross-collection portfolio, no badges/rookies/trophy surfaces. RPC's intelligence-first thesis is *validated and differentiated*, not threatened.
3. **They built the cart RPC shelved — natively, the right way.** Bulk buy is funded from a pre-loaded **Dapper Balance** ("Bulk purchases use Dapper Balance only"), which is exactly how they dodged the multi-transaction co-signer problem that made RPC's Cadence cart a tar pit. Conclusion: **never rebuild RPC's cart.** Send qualified buyers here instead.
4. **"Complete the Set" is now a productized one-click bulk-buy** — and RPC already has the data to do the *intelligence* version of it better (cheapest-path-to-complete, cross-set, FMV-aware) and deep-link into their checkout.
5. **Their own "unified marketplace" isn't unified yet** — "Unified search across all marketplaces is coming soon." Cross-collection is live on RPC today. There's a window to own cross-collection before they close it.

---

## What dapper.market is

Tagline: **"Your favorite leagues. One marketplace."** Three collections only:

- **NFL All Day**
- **NBA Top Shot**
- **LaLiga Golazos**

Notably **absent: Disney Pinnacle and UFC Strike** (both Dapper-published, both on RPC). Either they're rolling out collection-by-collection, or those two are deprioritized. Either way RPC currently has *broader collection coverage than Dapper's own marketplace.*

Top nav: **Explore / Market / Collection** + a "Pick a brand" league switcher + wallet/balance icon. Each league has its own Explore home, Market (search), and Collection (profile) surface. There is no cross-league browse yet.

### Market-health data they expose for free (observed 2026-06-08)

Their own homepage hands you the competitive picture RPC has been arguing internally:

| Collection | 7-day Volume | 7-day Sales | 7-day Buyers | Top Sale |
|---|---|---|---|---|
| NBA Top Shot | $466,279 | 36.5K | 1.8K | $17,250 (Steph Curry LEG) |
| NFL All Day | $8,762 | 2.4K | 151 | $20,015 (Mahomes ULT 1/1) |
| LaLiga Golazos | — | 0 | 0 | $422 |

NBA Top Shot league page also shows: **30d** Vol $1.7M / 138.4K sales / 3K buyers; **90d** Vol $6.4M / 353.2K sales / 5.5K buyers.

Read: **Top Shot is ~98% of the liquidity. All Day is a rounding error. LaLiga is clinically dead.** This is hard corroboration of RPC's "TS is the story" thesis, straight from Dapper's numbers.

---

## The cart / bulk-buy system (the thing you asked about)

Yes — fully reverse-engineered the flow. It's a **multi-select → serial-picker → balance-checkout** pattern, not a traditional persistent cart.

**Step 1 — Select mode.** On any Market browse grid (or a Set's Moments grid) there's a **"Select"** button. Clicking it drops a checkbox onto every card and turns the button into "Cancel (N)". A docked bottom bar appears.

**Step 2 — Multi-select.** Checking cards turns them blue and updates a live counter. The bottom bar shows a **thumbnail tray** of what you've picked, a **"Clear"**, and **"Select and Buy (N)"**.

**Step 3 — Serial picker drawer.** "Select and Buy" slides in a right-hand drawer titled **"Select Serial — N Editions selected. Not guaranteed until checkout."** For each edition you chose, it shows a mini **order book**: `Serial | Listing Price`, sorted cheapest-first (e.g. Luke Kornet #542 $7.15, #539 $7.49, #341 $7.90…). You pick one serial per edition; "Pick next Moment →" advances. A running **Total** updates live, with removable serial chips (`#542 ✕`).

**Step 4 — Checkout modal.** "Review Purchase" opens a clean line-item summary: thumbnail + serial badge, player, `TIER · Set · #/circulation`, play · matchup · date, price — then **Total** vs **Dapper Balance**, a blue **Checkout**, and Cancel. (I stopped here — did not complete any purchase.)

**The critical implementation details:**
- **"Bulk purchases use Dapper Balance only."** Bulk buy debits a *pre-funded* Dapper Balance (there's an "Add Balance" button on the profile). This is the whole trick — they sidestep N separate card/co-signer transactions by settling against an internal balance. This is precisely the wall RPC's Cadence cart hit.
- **"Not guaranteed until checkout."** Listings aren't escrow-locked while you shop; someone can buy your serial out from under you until you confirm. Honest, and cheaper to build.
- It's a **per-edition order book**, not "add this exact listing to cart" — you commit to an edition + budget, then bind to a specific serial at the drawer. Smart for thin/moving markets.

## The "Complete the Set" bulk-buy (also what you asked about)

Two layers:

1. **Discovery / merchandising.** Each league's Explore "Featured" rail surfaces set cards like **"WNBA Base Set · 28 Editions · ~$8.16 to Complete the Set · Shop"** and **"WNBA Rookie Debut · 30 Editions · ~$216.17 to Complete the Set."** The "to Complete the Set" number = sum of the cheapest live listing for each edition you're missing. "Shop" deep-links to the set page.
2. **Execution.** Set page → **Moments** tab → **"Select"** → a **"Select all"** button appears → one click selects every listed moment in the set (I confirmed **"47 selected"** in a single click on the 50-moment WNBA Base Set) → "Select moments" → the same serial-picker drawer → checkout from balance.

So "complete the set" is just the bulk-buy engine pointed at a set's missing editions, fronted by a merchandised cost-to-complete number. **RPC already computes cost-to-complete on its Set pages** (`lowestSingleAsk`, completion %). The gap is purely presentation + a deep link.

---

## Full feature inventory (what's on the site)

- **Cross-league live sales ticker** — interleaved NFL/NBA/LaLiga, with `@user · play · #serial/circ · price · time-ago`. (Trevor's own `@Jamesdillonbond` sales show up in it.)
- **Per-league market stats** — 7d on homepage cards, 30d/90d on league pages (Volume / Sales / Buyers / Top Sale).
- **Market browse** — Moments / Packs toggle; search; sort (Newest Release, etc.); quick-filter chips (Ultimates / Legendaries / Rares); team filter; availability filter (All / Listed / Offers); grid/list toggle; a **live-listings** view mode; an **analytics/chart** view mode.
- **Moment cards** show **listing price + "AVG SALE"** side by side — a built-in discount/fair-value hint (their FMV-lite).
- **Edition page** — tabs **Details / Listings / Offers / Activity**; **Lowest Ask**, **Avg Sale**, **"% Listed"** (a real supply/liquidity signal), a serial-level **price ladder** (order book), and **"Make An Offer"** (bids).
- **Packs** sold on secondary (Fast Break, Rookie Debut Box/Case/Standard, Top Shot This) with price + Avg Sale.
- **Set pages** — Details (composition: editions, players, teams, parallels, mint sizes, open/closed state) + Moments (browse + bulk-buy) + a **"Playlist"** showcase button.
- **Collection / profile** (`/<league>/collection/<username>`, public, username-based) — Moments / Packs counts, Offers, **My Balance + Add Balance**, sub-tabs **Overview / Packs / Sets**, moment grid with All/Listed/Offers filters, **"Select"** (bulk actions on your own inventory — i.e. bulk list/sell), and **"Customize."**

---

## What they DON'T have — RPC's moat, itemized

Everything RPC does that dapper.market does *not*:

- **FMV with confidence tiers** (they show a single "Avg Sale"; RPC has HIGH/MED/LOW/STALE/ASK_ONLY, serial-adjusted, outlier-filtered).
- **Squeeze / lock-rate / burn analytics** — nothing. This is RPC's single most differentiated surface and Dapper doesn't touch it.
- **Pack EV** — they sell packs but show no expected-value math.
- **Deal / discount scoring** (ask-vs-FMV ranking) — they show Avg Sale but don't *rank* underpriced listings.
- **Cross-collection portfolio / cohort** — explicitly "coming soon"; RPC has it live.
- **Badges, rookies index, trophy ladder, cross-collection cohort** — none.
- **Concierge / AI Q&A** — none.
- **Wallet/portfolio valuation, P/L, holdings analytics** — the Collection tab is inventory management (list/sell/organize/complete), not analytics.

The clean line: **Dapper owns the transaction + the raw "what sold." RPC owns the interpretation — what's underpriced, what's getting squeezed, what a pack is worth, what your whole cross-chain portfolio is worth.**

---

## Ideas & opportunities for RPC (prioritized)

### Do now — practically free, high leverage
1. **Add a dapper.market link next to the native one on every listing surface** (sniper, market, moment, edition, set pages) — keep native, add Dapper in Flowty's old slot. Deep-linkable shape RPC can build from data it already has: `https://dapper.market/<league>/moment/<momentId>` (league ∈ nba/nfl/laliga; momentId = the on-chain moment id RPC stores). Edition/profile pages use Dapper-internal ids RPC can't build, so moment links only. Makes RPC the front door for Dapper's marketplace. Handoff written: `docs/handoff-2026-06-08-dapper-market-outbound-links.md`.
2. **Add "~$X to complete the set →" CTA on RPC Set pages**, deep-linked to the dapper.market set page (which has the "Select all" bulk-buy). RPC already computes cost-to-complete; this is presentation + a link. RPC adds the brains (cheapest-path, FMV-aware, "is this set getting squeezed"), Dapper does the checkout.

### Differentiate — lean into what they can't/won't do
3. **Own cross-collection while their search is "coming soon."** Push the cross-collection portfolio, cohort, and "what the 100–2,000 moment collector holds across leagues" surfaces. This is a live RPC capability and an explicit Dapper gap.
4. **Position FMV as "real FMV vs their Avg Sale."** Their card shows a naive average; RPC shows confidence-tiered, serial-adjusted, outlier-filtered FMV + a discount score. A side-by-side "they say avg $X, real FMV is $Y, this listing is Z% under" is a concrete wedge — and a reason to check RPC *before* buying on Dapper.
5. **Cover what Dapper's marketplace doesn't:** Disney Pinnacle + UFC Strike have no dapper.market presence. RPC is the only intelligence *and* the only browsable surface for those two right now.
6. **"% Listed" is their one liquidity stat — RPC already has the better version** (squeeze board, effective-supply, lock+burn). Make the squeeze surface the thing collectors open before they buy on Dapper.

### Watch / strategic
7. **Treat dapper.market as the affiliate/partner rail, not a competitor to beat on transactions.** RPC should never try to out-marketplace Dapper (they have the co-signer, the balance, the custody). RPC's win condition is being the analytics layer that *drives* purchases there. If Dapper ever offers referral/affiliate attribution, RPC is perfectly positioned.
8. **Monitor the rollout.** If/when they (a) ship unified cross-league search, (b) add Pinnacle/UFC, or (c) bolt on real analytics, those each erode an RPC differentiator. The cross-league search and any "FMV/insights" tab are the two to watch hardest.
9. **Their live ticker + market-stat cards are a clean design reference** for RPC's own ticker/insights chrome — same data RPC has, well-merchandised.

### Explicitly do NOT do
- **Do not rebuild the RPC cart / live-buy.** Dapper solved it with a pre-funded balance + their own co-signer. RPC can't match that infra and shouldn't try — the intelligence-first shelving decision is now doubly correct.
- **Do not pursue an on-platform checkout.** Deep-link into theirs.

---

## Method note

Crawled live via Chrome on Trevor's logged-in session: homepage, Market picker, NBA Top Shot Explore + Market browse, the bulk-buy Select → serial-picker → checkout flow (cancelled before purchase), the WNBA Base Set page + "Select all" set-completion, an edition order-book page, and the Collection/profile. Stats are point-in-time (2026-06-08). Did not crawl NFL All Day / LaLiga league pages in depth (homepage stats captured) or the analytics/chart view mode — flagged for a follow-up pass if useful.
