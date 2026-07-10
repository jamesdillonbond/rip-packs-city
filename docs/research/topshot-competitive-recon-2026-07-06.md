# Top Shot competitive recon — 2026-07-06

Live Chrome crawl of **v2.nbatopshot.com** (the new NBA Top Shot flagship) and **dapper.market** (Dapper's in-house secondary marketplace), looking for features / UX / data surfaces RPC can leverage.

This is a **delta** on [`docs/research/dapper-market-recon-2026-06-08.md`](dapper-market-recon-2026-06-08.md). That doc already settled: add outbound dapper.market links, don't rebuild the cart, own cross-collection, cost-to-complete deep links, FMV-vs-Avg-Sale wedge. All of that still stands and is not repeated here. What's new since June 8 is (a) **v2.nbatopshot.com launched as a redesigned flagship** with a heavy loyalty/gamification layer and per-edition ownership intel, and (b) **dapper.market added several intelligence-lite UX signals** RPC can beat with data it already stores.

---

## TL;DR — the seven things worth acting on

1. **v2 edition pages now ship "Top Collectors" + "Special Serials" per edition.** RPC already has a special-serial-owners board (wmc-backed) but doesn't surface it on entity pages. Surfacing "who owns #1 / #jersey / #N/N" and a most-owned leaderboard on RPC edition pages is mostly a presentation lift on existing data. (Most-Owned is gated by RPC's incomplete ownership index — see caveat.)
2. **dapper.market now prints an inline Low-ask-vs-Avg-sale % delta on every card** (e.g. `-24.1%`). That's their discount signal — and it's naive (avg of raw sales). RPC's FMV is confidence-tiered, serial-adjusted, outlier-filtered. Printing an **FMV-based discount % inline on every RPC browse/entity card** is a strict upgrade and a reason to check RPC *before* buying on Dapper.
3. **dapper.market has a market "Insights" drawer** (24h/7d/30d/60d → Volume / Purchases / Buyers / Sellers + Top Purchases). RPC already has a `/api/market-pulse` route + `get_market_pulse_all` RPC but no prominent public surface. Ship a **Market Pulse board** — RPC has richer sales data than Dapper exposes.
4. **Parallels are fully first-class on both sites** (Cosmic / Holo MMXX / Hexwave / Galactic / Omega / Diced / Blockchain / Hardcourt), named + filterable — but neither shows **per-parallel FMV or premium analytics**. RPC just finished the `::subID` conflation split, so RPC can now price each parallel and rank parallel premiums — a surface *neither competitor has*.
5. **v2 added a full loyalty/seasons layer** (Summer Circuit: Season Points, Ranks Prospect→Starter, rank-based marketplace discount, Rewards Store with declining point-price, a Pick'em prediction league, Fast Break Classic/Pro). RPC's rewards program is built but hidden. This validates the direction; details below are worth mirroring selectively.
6. **v2 Drops carry "Add to Calendar" + live countdowns.** RPC has `rpc-flow-ecosystem-watch` data but no public drop calendar. A **Flow-wide drop calendar** (all 5 collections, countdowns, EV context) is an RPC-only cross-collection play.
7. **dapper.market curated quick-filters expanded**: Ultimates / Legendaries / Rares / **Autographs / Rookies / Bargain Bin**. "Bargain Bin" is a one-tap under-value entry — RPC's deals board is the smarter version but lacks the one-tap merchandised entry points.

---

## v2.nbatopshot.com — what the new flagship added

Bottom-nav app shell: **Explore / Drops / Market / Play / Collection**. Notable surfaces:

### Per-edition ownership intel (NEW, high-relevance)
Edition pages (`/edition/<id>`) now carry, below the Details/Listings/Offers/Activity tabs:
- **Top Collectors — "Most Owned"** leaderboard (rank · username · #Moments held of that edition). e.g. `cle_287 — 53`, `self_assured_sea_horse4973 — 52`.
- **Special Serials** with owner: `#1 → (owner or "Not distributed yet") · #5 → Optimism · #1000 → greatestpiratehunter`.
- Set-completion mini-badges inline (Player 0/1, Team 24/31 within the series).
- A price-history chart icon, share, and bookmark on the hero.

**RPC leverage:** RPC has `topshot_special_serial_owners` (wmc-backed, per-parallel-correct per the 07-06 memory) and computes set/team completion. Surfacing a Special-Serials owner strip + set-completion badges on RPC edition pages is a data-you-already-have lift. **Caveat on Most-Owned:** RPC's ownership index is shallow (wmc ≈ 241 wallets; `rpc-no-complete-ownership-index`), so a faithful "most owned" leaderboard is blocked until `topshot_ownership` is filled — don't ship a partial one that looks wrong.

### Loyalty / seasons (Summer Circuit)
- **Season Points** + **Rank** ladder (Prospect → Starter → …); rank persists (spending points doesn't reduce rank).
- **Rank benefits**: `1 pt per $1 spent`, and **2.5% marketplace discount unlocked at Starter**, Points Store access, a rank badge.
- **Rewards Store**: limited collectibles for points, each with a **scheduled price drop** ("Next price drop at 12:00 AM ET — 370,000 pts", "Only 1 Available") — a Dutch-auction-on-points mechanic that drives daily returns.
- **Pick'em / Win-Loss League**: "Pick the winner of the next playoff game. Win to double your points, lose and get your points back." Plus a global Play-To-Win leaderboard.
- **Fast Break** (`/fastbreak`): Classic / Pro / Live; daily stat-target lineups from owned moments; standings + prizes; entry counts shown.

**RPC leverage:** RPC's rewards program (off-chain points→prizes, no chance, no physical) is live-but-hidden. The mechanics worth borrowing *if/when* rewards is un-hidden: the **declining-price rewards store** (creates a daily check-in loop) and **rank-based perks**. The Pick'em "lose and get points back" is a no-downside engagement hook. These are engagement mechanics, not intelligence — keep them subordinate to the intelligence thesis and gated behind traction (`no-paywall-until-traction`).

### Drops
- Drop cards with **"Add to Calendar"**, **countdown timer**, pack composition ("13 Moments", "7 Moments"), Details.

**RPC leverage:** a **cross-collection Flow drop calendar** (all 5 collections, not just TS) with countdowns + RPC's pack-EV context is a surface Dapper/TS can't match (they're NBA-only). Feeds the `rpc-flow-ecosystem-watch` data into a public page.

---

## dapper.market — UX signals added since June 8

- **Inline discount %** on every moment card: `Buy $645 · Low ask: $645 · -24.1% · Avg sale: $748.40`. Green `+` / red-ish `-` vs avg sale. Naive (raw-sale average, no confidence, no serial adjustment).
- **Insights drawer** (chart icon on search): window toggle 24h/7d/30d/60d → **Sales Volume / Purchases / Buyers / Sellers** cards + **Top Purchases** list (with parallel name + serial badge, e.g. `Luka Dončić · LEGENDARY · Standard #/49 · Cosmic · #34 · $1,850`). "Updated less than a minute ago."
- **Parallels selector** first-class on edition pages; parallel names appear in search cards and top-sales.
- **Expanded quick-filters**: Ultimates / Legendaries / Rares / Autographs / Rookies / **Bargain Bin**.
- **Filter drawer**: League, Sort, Status, **Ownership (All / Owned / Not Owned)**, **My Offers**, Player, Teams, **Low Ask (range)**, **Avg Sale (range)**, Set, Series.
- **Offers-first fallback**: editions with 0 listings show "No Listings Available… make an offer" + Make An Offer.
- Grid/list + **Live** toggle; Apple Pay; bottom mobile nav.
- Backend is the **Atlas API** (`api.production.atlas.dapperlabs.com` — `EditionService/SearchEditions`, `SetService/SearchSets`, `DrawService/GetDrawOrders`), JWT-gated (RPC already uses Atlas for AllDay badges).

**RPC leverage:** RPC already ranks underpriced listings (deals board) with *modeled* FMV — the move is to **push that discount % inline everywhere a price is shown**, labeled against real FMV not avg-sale, so RPC's card is visibly smarter than Dapper's. The Ownership (Owned/Not-Owned) and range filters are a good spec for RPC's own wallet-aware browse if/when built.

---

## Prioritized opportunities for RPC

Weighted for the constraints: intelligence-first, no on-platform buy, solo dev, cost-flat, pre-traction.

### Ship-worthy now (data already exists)
1. **Per-parallel FMV + a Parallel Premiums surface.** RPC's `::subID` split is done; neither competitor prices parallels. Rank "this parallel trades at Nx the Standard" across editions. This is a *net-new, competitor-unmatched* intelligence surface and directly extends existing serial-premium/FMV work.
2. **Inline FMV discount % on all browse/entity/deal cards** — "listing is Z% under RPC FMV (HIGH)". Beats Dapper's avg-sale delta on the same visual real estate.
3. **Market Pulse public board** — wire the existing `/api/market-pulse` + `get_market_pulse_all` into a real `/insights` surface with 24h/7d/30d/60d Volume / Buyers / Sellers / Top Sales, per collection. Cross-collection = a Dapper gap.
4. **Special-Serials owner strip on edition pages** — surface `topshot_special_serial_owners` (#1 / jersey / perfect serial owner) inline. Existing board, new placement.

### Higher-effort / gated
5. **Flow-wide drop calendar** with countdowns + pack-EV context (all 5 collections) — cross-collection drop intel Dapper can't do.
6. **Merchandised quick-entry chips** on RPC market/insights ("Under FMV by tier", "Rookies", a smarter "Bargain Bin") — one-tap into the deals board slices RPC already computes.
7. **Set completion journey + set leaderboards** — RPC has team-hub cost-to-complete; port the pattern to sets (v2 and dapper both merchandise this hard).

### Don't
- Don't build Most-Owned leaderboards until the ownership index is complete (`rpc-no-complete-ownership-index`) — a partial one renders wrong.
- Don't rebuild the cart / on-platform checkout (settled June 8; v2's rank-discount + Dapper balance make it doubly Dapper's game).
- Don't chase the loyalty/seasons layer as a headline feature pre-traction — mirror only the engagement mechanics if/when rewards is un-hidden.

---

## Method note
Live Chrome crawl 2026-07-06 (logged-in Dapper session): dapper.market homepage, NBA league page, moments search grid (+ filter drawer + Insights drawer), an edition page (listings/offers), a set page with completion/leaderboards; v2.nbatopshot.com homepage, an edition page (Top Collectors + Special Serials), /progression (Summer Circuit), /fastbreak. Stats are point-in-time. Atlas API is JWT-gated (not called unauthenticated). No purchases made.
