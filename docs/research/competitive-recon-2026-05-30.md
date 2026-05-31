# Competitive & Inspiration Recon — Observation Log (2026-05-30)

**Mode: pure observation.** This document records what competitor and inspiration platforms *do* — feature sets, information architecture, UX/CX patterns — as observed on 2026-05-30. It deliberately contains **no recommendations, no "RPC should," no prioritization, no build candidates.** It is reference material for future strategy threads. Conclusions are left to the reader.

Build-candidate specs derived from this recon: [competitive-build-candidates-2026-05-30.md](competitive-build-candidates-2026-05-30.md) (RPC Index, wallet-paste landing, movers + live ticker).

---

## Sourcing & confidence (read this first)

Captured via Chrome on public/unauthenticated views, plus web research for gated surfaces. Honesty about what is first-hand vs. second-hand:

| Platform | How observed | Confidence |
|---|---|---|
| **LiveToken** | Live — top nav, /deals/live, /myaccount?address= (wallet-addressable) | High for nav + account IA + deal controls; homepage body + populated data tables did NOT render unauthenticated |
| **MomentRanks** | Live — homepage, /leaderboard, /activity | High (first-hand IA & controls) |
| **Evaluate.Market** | Live — homepage + nav | High (first-hand IA) |
| **CryptoSlam** | Live — /nba-top-shot | High (first-hand IA; used as a Top Shot market-data substitute) |
| **OTM (On The Margin)** | Live — /nbatopshot | Medium (homepage/IA only) |
| **Flowverse** | Live — Flow app directory | Medium (directory listing) |
| **OpenSea** | Live — /rankings, a collection page | High (first-hand IA & controls) |
| **Blur** | Live — homepage, /collections (most content wallet-gated) | Medium-High (nav + collections table; deeper trading UI gated) |
| **Card Ladder** | Live — /indexes | Medium-High (indexes page first-hand; portfolio gated) |
| **NBA Top Shot** | **BLOCKED** — nbatopshot.com is disallowed by this browser's safety restrictions | Research-derived only |
| **Magic Eden** | Web research only | Research-derived |
| TopMoment / Momentum Labs / MomentMob | Web research only | Research-derived |

Specific in-table dollar values seen on LiveToken/CryptoSlam (e.g. a "LeBron James … $1,234 +5.2%" row) are treated as **illustrative**, not verified figures — the *column structure* is the reliable observation, not any single cell. No transactions, logins, wallet connects, or secret exposure occurred.

---

## Part 1 — Flow / sports-collectible tools (RPC's direct category)

### NBA Top Shot (incumbent platform) — *research-derived; site blocked this session*
The official Dapper marketplace. Observed via research + prior knowledge, not live this session.
- **Marketplace filters:** Series, Set, Team, Player, Tier, Play Type, Set Rarity, Badges, Price, Serial range, Game Date. Sorts: Lowest/Highest Ask, Recently Listed, Top Sales, Top Shot Score, Serial. Per-card watchlist heart.
- **Moment page:** Lowest Ask, # Listed, Highest Offer, embedded highlight video, price history (last sale + ranges), serials-for-sale list, circulation breakdown, owner activity.
- **Supply transparency (per their own docs):** collectors can see, per moment, serials split into **Unlisted / For Sale / Locked**, plus in-packs, in Locker Room, and **Burned**. (Source: Top Shot support + burn blog.) The raw inputs to an "effective supply" figure exist in their data; the marketplace UI surfaces circulation rather than a computed `circulation − burned − locked`.
- **Gamification mechanics:** Set-Collecting Challenges, Crafting Challenges, Pack Drops, Flash Challenges, Team & Player Leaderboards, **Locking** (lock a moment 1 yr to contribute its Top Shot Score to leaderboards), Captain's Clubs (team communities), Trade Ticket events.
- **Scarcity conventions collectors price on:** low serials, jersey-match serials, birth-year/number serials, Top Shot Debuts, rookie moments (these were protected from the Great Burn).
- **2026 note:** Top Shot is moving footage/artwork fully on-chain and has publicly invited third-party tooling/analytics built on the public data.

### LiveToken — NBA Top Shot companion analytics tool
Closest direct analytics competitor.

**Observed live this session (first-hand):**
- **Top nav:** MY ACCOUNT · LISTINGS · DEALS · OFFERS · LEADERBOARDS · TOOLS (+ Twitter, Discord, and an external "Tournament Pickle" link).
- **Wallet-addressable, NO login:** `/myaccount?address=<flow-addr>&mode=portfolio` loads any wallet's account with no sign-in (rendered Trevor's wallet header — handle, a total score figure, join date "2/28/2021"). Sub-tabs: **Portfolio · Listings · Offers · Sales · Auctions · Feedback · Activity Log**. Controls include "Sort by Acquired (recent)" and "Show advanced filters." (Same wallet-paste pattern as MomentRanks — this **corrects** an earlier assumption that LiveToken's portfolio was sign-in-gated.)
- **Deals (`/deals/live`):** a real-time deal feed, not a static table. Tabs: Live · Alerts · Deals FAQ. Controls: a liquidity filter ("Any 💧"), a "Silence" toggle (audible/notification alerts on incoming deals), and "Show advanced filters." Their most "trader-cockpit" surface.
- Dedicated **LISTINGS, OFFERS, LEADERBOARDS, and TOOLS (community-tools)** routes exist as top-level nav.

**Per research / prior knowledge (NOT confirmed live — the homepage body never rendered for me, returned empty):**
- Positioned as a Top Shot companion; commonly described as Top Shot-focused (could NOT confirm whether All Day / other collections are covered — earlier "Top Shot-only" claim is unverified).
- Marketed features reportedly include a deal finder for undervalued moments, portfolio analytics (value/ROI/P&L), set-completion tracking, and player-performance-to-price correlation. **Treat as unverified marketing claims** until observed; I did not see the homepage copy, marketplace columns, players table, or any "pricing coming soon" modal this session, despite an earlier draft asserting them.

**Data caveat:** populated data tables rendered empty for me on `/marketplace` and `/deals` unauthenticated. I confirmed the nav, the wallet-addressable account view, and the deal-feed controls; I did NOT verify populated marketplace/deal data or specific column sets.

### MomentRanks — *live-observed (prior pass) + research*
Multi-collection portfolio + analytics, wallet-first.
- **"MR Value" methodology (research):** factors sales history, player, series, set, serial number, tier, and total circulation; a separate **"Serial Estimator"** models the serial-number premium (low/jersey-match serials). Exact formula is proprietary/undisclosed, and reviewers note **MR Value and competitor valuations diverge noticeably** — i.e. there is no agreed-upon fair value across tools, which is a *trust* opening for whoever shows their work (RPC's confidence taxonomy is exactly that kind of "show your work" signal).
- **Nav/IA:** Home · Marketplace · Activity · Leaderboard; a top-level **"Search wallet address or username"** box; Connect.
- **Onboarding:** wallet-paste is the hero action — "Enter wallet address → Search" with no login required to value an account. Hero copy: "Track your NFT portfolio / Real-time valuations for NBA Top Shot, NFL All Day, and more."
- **Coverage:** "Multi-chain portfolio tracking across **Flow and Ethereum**."
- **Pricing model:** proprietary **"MR Value"** per moment.
- **Leaderboard:** "Top Collectors," tabs **By Value / By Moments / By Profit**; table = Rank · Collector · Portfolio Value · Moments · Profit/Loss. "Rankings update in real-time."
- **Activity:** "Live Sales Activity" real-time feed; columns = Moment · Player · Set · Serial · Sale Price · **MR Value · Δ vs Value** · Time; filters = Collection / Tier / Price range / Set; rows link to a moment page with sales history + price chart. (Notable: the discount-vs-fair-value figure appears inline in the live feed.)

### Evaluate.Market — *live-observed (prior pass) + research*
- **Positioning:** "The complete NBA Top Shot, NFL All Day & UFC Strike toolkit" (multi-collection across Dapper's sports titles).
- **Nav/IA:** Marketplace · Portfolio · Sets · **Swaps** · Activity · Sign In.
- **Features observed/stated:** marketplace aggregator with advanced filters (rarity, serial, badges, price, set); portfolio real-time value + acquisition tracking; set completion + challenge tracking; **peer-to-peer NFT swap finder ("find trade partners")**; per-moment scarcity/rarity scoring.
- The Swaps / trade-partner-finder is a feature not seen on the other tools in this log.
- **Distribution moat (important):** Evaluate.Market received NBA Top Shot's **official stamp of approval and is embedded directly into each moment's page on nbatopshot.com** ("each moment has a direct link to Evaluate.Market"). That is a structural distribution advantage no other third-party tool has — Top Shot funnels its own traffic to them. Worth noting when thinking about how RPC earns top-of-funnel reach without that built-in pipe.

### CryptoSlam — *live-observed* (general NFT data aggregator; used here as a Top Shot market-data substitute)
- **Tabs:** Overview · Sales · Top Sales · Mints · Holders · Scarcity. Time windows 24h/7d/30d/All.
- **Overview stats:** Total Sales Volume, Transactions, Buyers, Sellers, Floor.
- **Surfaces:** Top Sales feed, Recent Sales feed, **Market Cap ranking**, Attributes/Traits breakdown, Scarcity data, and an **account-valuation tool (wallet paste)**.

### OTM — On The Margin — *live-observed (homepage/IA)*
- NBA Top Shot analytics: floor-price trend charts, volume, **market cap over time**, set-level and player-level breakdowns, portfolio valuation. Free + premium tiers.

### Flowverse — *live-observed (directory)*
- The Flow ecosystem app directory. Categorizes Flow apps: Marketplaces, Tools & Analytics, Games, DeFi, Wallets. Useful as a discovery index of what exists in the Flow tooling space (lists the analytics tools above alongside marketplaces like Gaia, etc.).

### Other Flow tools — *research-derived (not visited live)*
- **TopMoment** — companion app, real-time account valuation across NBA Top Shot, NFL All Day, UFC Strike.
- **Momentum Labs** — "tools, analytics and community" for NBA Top Shot + NFL All Day.
- **MomentMob** — NBA Top Shot analysis.
- Historical/secondary marketplaces referenced in the ecosystem: Gaia, BloctoBay.

---

## Part 2 — General NFT marketplaces (UX/CX inspiration, different asset class)

### OpenSea — *live-observed*
Largest general NFT marketplace; strong discovery + collection-page IA.
- **Global nav:** Drops · Stats · Profile · Wallet; universal search across "items, collections, and accounts."
- **Rankings (/rankings):** tabs **Trending / Top / Watchlist**; time windows **1h / 6h / 24h / 7d / 30d / All**; **chain filter** dropdown ("All chains"); table columns = Collection · Floor price · Floor change · Volume · Volume change · Sales · % listed · Owners.
- **Collection page IA:** stats bar (Floor price · Total volume · Best offer · Listed · Owners); tabs **Items · Offers · Analytics · Activity**.
  - **Items:** left-rail filters — Status (Buy Now / Auction / New), Price (Min/Max), **Traits grouped by attribute** (Background, Skin, Body, Face, Head…), rarity-rank; sort (e.g. "Price low to high"); item cards show #, price, last sale, **rarity rank**, best offer; **Sweep**, **Buy now**, **Add to cart**.
  - **Offers:** collection-wide and trait-level offers.
  - **Analytics:** price history, volume, sales.
  - **Activity:** filterable real-time event feed (sales/listings/offers/transfers).

### Blur — *live-observed (nav + collections; deeper trading UI wallet-gated)*
NFT marketplace explicitly "for pro traders."
- **Nav/IA:** Collections · Portfolio · **Liquidity** · **Rewards** · Connect Wallet; collection search.
- **Collections table:** columns = Collection · Floor · **Top Bid** · 1D Change · Volume · Owners · Supply; time tabs 24H/7D/30D/All. (Bid-centric: "Top Bid" is a first-class column next to Floor.)
- **Trader View / Collector View toggle** — switch between a stats-dense trading layout and a visual/image-forward layout.
- **"Liquidity" nav** = bidding pools / lending (Blend). **"Rewards" nav** = points/airdrop loyalty program.
- (Per research) deeper trading features: **bid depth-of-market visualization** (ETH stacked at each price level below floor), **collection bids**, **trait bids**, **floor sweeping** (up to ~30 at once with filters), real-time portfolio P&L; interface refreshes ~every 4s; 0% marketplace fee.

### Card Ladder — *live-observed (/indexes)* (physical sports cards; same investor psychology, different asset)
- **Nav/IA:** Explore · Indexes · My Collection · Sales · News · Sign Up.
- **The Index (flagship):** *"tracks the value of the sports card market over time, similar to how the S&P 500 tracks the stock market."* Built on their proprietary tech + **vetted sales**.
  - **CL50** — "the 50 cards that best represent the overall market." **Methodology (per their Zendesk, corrects an earlier draft): the CL50 is a SIMPLE AVERAGE — each day, sum the current value of the 50 cards and divide by 50. It is NOT market-cap weighted.** Card selection = the highest grade copy that still sells frequently enough to capture short-term fluctuation; constituents are editorially curated and change over time (discretionary reconstitution). Explicitly "not designed to represent the hobby as a whole" — it's a flagship-50 tracker.
  - **"Card Ladder Value"** is a *separate* product from the indexes — a per-card price model described as "the intersection of player indexes & price modeling." So they run two things: curated indexes (trend) AND a per-item modeled value (pricing).
  - Sub-indexes: Vintage (pre-1980) / Modern / Ultra-Modern; by sport (Basketball/Football/Baseball/Soccer/Pokémon).
  - Chart time windows: 1M/3M/6M/1Y/All; **Compare Indexes** against each other; Pro members compare their **own collection vs. any index**.
- **(Per research) other features:** 100M+ aggregated sales across eBay/Goldin/Heritage/Fanatics etc.; **population reports** (PSA/BGS/SGC/CGC) with pop-growth tracking; My Collection value-over-time + cost basis + ROI; movers; price alerts; market news/newsletter. ~330k users. Free tier + Card Ladder Pro.

### Magic Eden — *research-derived (not visited live)*
Multi-chain marketplace.
- Unifies 10+ chains (Solana, Ethereum, Bitcoin/Ordinals, Polygon, Base…) in one UI; non-custodial cross-chain wallet with portfolio + swaps.
- **Diamonds/$ME rewards** loyalty (quests + staking); NFT launchpad + creator dashboard; cross-marketplace aggregation; ME Stats rankings; mobile-forward.

---

## Part 3 — Cross-platform feature matrix (observation)

Presence of a feature as observed/known on each platform. ✓ = present, — = not observed/absent, ~ = partial/gated. The **RPC column is a factual capability snapshot from internal docs (CLAUDE.md, 2026-05-30) for reference only** — its inclusion is descriptive, not a gap analysis or recommendation.

| Feature | TopShot | LiveToken | MomentRanks | Evaluate | CryptoSlam | OpenSea | Blur | CardLadder | RPC (today, per internal docs) |
|---|---|---|---|---|---|---|---|---|---|
| Computed fair value / FMV | — | ✓ | ✓ (MR Value) | ~ | — | — | — | ✓ (est. value) | ✓ (confidence-tagged) |
| FMV confidence taxonomy | — | — | — | — | — | — | — | — | ✓ (HIGH/MED/LOW/STALE/NO_DATA) |
| Δ-vs-FMV / discount surfacing | — | ✓ | ✓ (inline in feed) | — | — | — | — | — | ✓ (sniper/deals) |
| Effective supply (circ−burn−lock) | ~ (raw inputs shown) | — | — | — | ~ (scarcity tab) | — | — | n/a | ✓ (squeeze board) |
| Pack expected value (EV) | — | — | — | — | — | — | — | n/a | ✓ |
| Portfolio value | ~ | ✓ | ✓ | ✓ | ✓ (wallet val.) | ✓ (profile) | ✓ | ✓ | ✓ |
| Cost basis / realized P&L | — | ✓ (gated) | ✓ | ✓ (acq. track) | — | — | ✓ | ✓ | ~ (holdings, not P&L) |
| Wallet-paste (no-login) onboarding | — | ✓ (?address=) | ✓ | — | ✓ | — | — | — | — (login-gated `/`) |
| Live activity / sales feed | ~ | ✓ (deal feed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (sales) | ~ |
| Biggest-movers board | — | ~ | ✓ | — | ✓ | ✓ (trending) | ✓ | ✓ | — |
| Market-cap / index surface | — | ✓ (player mcap) | ✓ | — | ✓ (mcap rank) | — | — | ✓ (Index/CL50) | — |
| Set-completion tracker | ✓ | ✓ | ~ | ✓ | — | n/a | n/a | n/a | ✓ |
| Player-performance → price | — | ✓ | — | — | — | n/a | n/a | n/a | ~ (sports proxy exists) |
| Price prediction / forecast | — | ✓ (AI) | — | — | — | — | — | — | — |
| Alerts (price/deal) | ~ | ✓ | ~ | — | — | ~ | ~ | ✓ | ~ (partially decommissioned) |
| Leaderboard (collectors) | ✓ | — | ✓ | — | — | — | — | — | ~ |
| Trait/badge filter w/ rarity % | ✓ | ~ | ~ | ✓ | ✓ (scarcity) | ✓ | ✓ | n/a | ~ |
| P2P swap / trade-finder | ~ (trade tickets) | — | — | ✓ | — | — | — | — | — |
| Multi-collection coverage | ✓ (5 Dapper) | — (TS only) | ✓ (Flow+ETH) | ✓ (3 Dapper) | ✓ (all) | ✓ (all) | ✓ (ETH) | ✓ (cards) | ✓ (5 Flow) |
| Depth-of-market / bid book | — | — | — | — | — | ~ (offers) | ✓ | — | — |
| Loyalty / points / rewards | ✓ (scores) | — | — | — | — | ~ | ✓ | — | — |
| Live-buy / checkout in-app | ✓ | — (outbound) | — (outbound) | ~ | — | ✓ | ✓ | n/a | — (outbound by design) |

*(n/a = not applicable to that platform's asset class. ~ for RPC reflects internal-doc notes that a capability is partial, exists in data but not surfaced, or was decommissioned.)*

---

## Part 4 — Recurring patterns observed across platforms (descriptive)

Neutral observations about what shows up repeatedly. No judgment about whether RPC should adopt any of them.

1. **Computed fair value + a discount-vs-fair-value figure** appears on every dedicated analytics tool (LiveToken, MomentRanks, OTM, Card Ladder). The general marketplaces (OpenSea, Blur) show floor/last-sale/bids instead of a modeled value.
2. **Wallet-paste, no-login onboarding** is available on MomentRanks, CryptoSlam, AND LiveToken (`/myaccount?address=`) — three of the analytics tools let you value any wallet with no sign-in. The general marketplaces (OpenSea, Blur) gate portfolio behind wallet-connect instead.
3. **A real-time activity/sales feed** exists on nearly every platform; several (MomentRanks, LiveToken) annotate each row with the fair-value delta; LiveToken adds audio alerts.
4. **Time-window toggles (1h→All)** are a universal control on ranking/stats surfaces.
5. **A market-cap or index surface** recurs (Card Ladder's Index/CL50, CryptoSlam market cap, MomentRanks, LiveToken player market cap) as the "state of the whole market" view.
6. **Collection-page tab template** on marketplaces is consistently Items / Offers / Analytics / Activity (OpenSea); Blur offers a Trader/Collector view toggle over similar data.
7. **Trait/attribute filtering with inline rarity** is standard on marketplaces and rarity tools.
8. **Set-completion + "cheapest path to completion"** is a shared feature among the Dapper-sports tools (Top Shot, LiveToken, Evaluate).
9. **Player-performance-to-price correlation** is claimed only by LiveToken among the tools seen.
10. **Loyalty/points** mechanics are a marketplace-retention pattern (Blur Rewards, Magic Eden Diamonds, Top Shot scores), absent from the pure analytics tools.
11. **Monetization sequencing:** both LiveToken (explicitly "Pricing Coming Soon") and the broader tools run free-now / paid-later; paid tiers, where present, gate cost-basis/P&L, deeper deal history, alerts, and API (LiveToken Elite, Card Ladder Pro).
12. **Effective supply (circulation minus burned minus locked) is not surfaced as a single computed figure by any native marketplace observed** — Top Shot exposes the component counts (For Sale / Locked / Burned) and CryptoSlam has a scarcity tab, but neither presents a combined squeeze metric.

---

## Part 5 — Collector pain points (validated demand, from r/nbatopshot + collector guides)

What collectors *say* is missing or broken. This matters more than the feature lists above: it's demand in collectors' own words, and it maps almost 1:1 onto surfaces RPC already has or is considering. (Source: r/nbatopshot threads + collector valuation guides + Top Shot's own 2025-26 roadmap; sentiment summary, not individual-post quotes.)

1. **"I can't determine fair market value" / valuation distrust.** The loudest theme is anxiety about what a moment is actually worth, made worse by volatility and by tools giving different numbers (MR Value vs. others diverge). There is **no trusted source of truth for value**. → This is exactly what a *confidence-tagged* FMV answers: RPC's HIGH/MED/LOW/STALE/NO_DATA is a "show your work" trust signal in a market that has none. The honesty is the product.

2. **Liquidity fear.** Collectors report not being able to sell, or only at pennies. "Can I actually exit this position?" is unanswered by any tool that shows only a price. → A **liquidity signal (sales/30d, # listed, bid depth)** next to every value directly addresses the #1 anxiety. LiveToken's liquidity filter and Blur's bid-depth are the patterns; RPC has the sales data to compute it.

3. **"Headline circulation lies."** Collectors *explicitly* articulate that mint count ≠ true supply, and that real scarcity = mint − locked − burned − inactive; they compute it by hand and say "savvy collectors factor this in." Notably, **Top Shot's own 2025-26 roadmap leans into scarcity** (tighter mints across tiers; Crafting Challenges permanently delete moments) — so the platform itself is validating that scarcity is the value story. → This is the **squeeze board's exact reason to exist, validated in both collector language and the platform's own direction.** The cohort that talks this way *is* RPC's 100–2,000-moment target customer. Strongest "build/amplify this" signal in the recon.

4. **Top Shot platform distrust / "is it dead."** Heavy negative sentiment about Dapper's management and the decline from the 2021 peak. → Double-edged: the category shrank, but an *independent, honest, collector-aligned* intelligence layer (explicitly not Dapper) has trust-vacuum room to occupy. RPC's independence + Team Captain credibility is an asset *because* the mothership is distrusted.

**Net:** three of RPC's existing/planned surfaces — confidence-tagged FMV, a liquidity signal, and the squeeze board — map directly onto the three loudest collector complaints. The recon's strongest conclusion is less "build new things" and more "the things RPC already bet on are the things collectors are explicitly asking for; surface them louder and earn trust as the honest, independent source of truth."

---

## Part 6 — Borrowable standard: OpenRarity (entropy-based rarity)

OpenSea ranks rarity via **OpenRarity**, an open-source standard (OpenSea + Curio + icy.tools + PROOF). Instead of *summing* individual trait probabilities (the naive method, which they argue is inaccurate), it uses **information content / entropy** — rarity = the statistical improbability ("how surprised you'd be") of a token's full trait combination, via the multiplication rule, with special handling for 1-of-1 traits and trait-count weighting. Open-source at ProjectOpenRarity on GitHub. For any RPC surface that ranks editions by trait/badge/parallel rarity, adopting a published entropy method (rather than inventing one) is more rigorous *and* a trust signal — "we use the open standard" echoes the valuation-distrust theme. Caveat: Top Shot moments carry fewer independent traits than PFP collections, so entropy-rarity applies best to badge/serial/parallel dimensions, not a full trait stack.

---

## Sources (for research-derived sections)
- Card Ladder — [cardladder.com](https://www.cardladder.com/) · [Indexes](https://www.cardladder.com/indexes) · [SI feature](https://www.si.com/collectibles/inside-the-hobby/the-platform-that-changed)
- Blur — [blur.io](https://blur.io/) · [Bankless guide](https://www.bankless.com/the-bankless-guide-to-blur) · [DEXTools tutorial 2026](https://www.dextools.io/tutorials/how-to-use-blur-nft-marketplace-tutorial-2026)
- Magic Eden — [nftnow: rewards + cross-chain wallet](https://nftnow.com/news/magic-eden-reveals-rewards-platform-and-cross-chain-wallet/) · [Gate glossary](https://www.gate.com/learn/glossary/what-is-magic-eden)
- Top Shot tools landscape — [Top Shot 101: best tools](https://topshot101.com/best-tools/) · [evaluate.market](https://www.cypherhunter.com/en/p/evaluate-market/) · [CryptoSlam](https://www.cryptoslam.io/nba-top-shot) · [Flowverse](https://www.flowverse.co/applications/nba-top-shot)
- Top Shot scarcity/burn/lock — [The Great Burn](https://blog.nbatopshot.com/posts/burning-moments) · [Locking Moments and Sets](https://support.nbatopshot.com/hc/en-us/articles/7738397259923-Locking-Moments-and-Sets) · [Burned Moment NFTs](https://support.nbatopshot.com/hc/en-us/articles/4404353394451-Burned-Moment-NFTs)
- Card Ladder index methodology — [What is the CL50 (Zendesk)](https://cardladder.zendesk.com/hc/en-us/articles/11943112663063-What-is-the-CL50) · [What are Indexes (Zendesk)](https://cardladder.zendesk.com/hc/en-us/articles/11943014102167-What-are-Indexes) · [Card Ladder Value](https://cardladder.zendesk.com/hc/en-us/articles/11943876265239-What-is-Card-Ladder-Value)
- Collector pain points — r/nbatopshot ([liquidity/"dead" sentiment](https://www.reddit.com/r/nbatopshot/comments/1lcuj9w/reddit_nba_topshot_is_dead/) · [locking & scarcity](https://www.reddit.com/r/nbatopshot/comments/1aktz8r/how_does_locking_moments_increase_scarcity/) · [circulating supply](https://www.reddit.com/r/nbatopshot/comments/p9k3ld/understanding_circulating_supply/))
- OpenRarity — [OpenSea: OpenRarity standard](https://opensea.io/blog/articles/openrarity-a-new-rarity-standard) · [ProjectOpenRarity (GitHub)](https://github.com/ProjectOpenRarity)
- MomentRanks valuation — [MomentRanks resource](https://momentranks.com/blog/momentranks-nba-top-shot-resource)
- Blur pro features — [DEXTools 2026 tutorial](https://www.dextools.io/tutorials/how-to-use-blur-nft-marketplace-tutorial-2026) · [Cryptoadventure Blur review 2026](https://cryptoadventure.com/blur-review-2026-pro-nft-marketplace-features-fees-and-blend-lending/)
