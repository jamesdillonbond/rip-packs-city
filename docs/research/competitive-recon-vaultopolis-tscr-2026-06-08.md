# Competitive recon — Vaultopolis + Top Shot Community Rewards (2026-06-08)

Trevor-requested look at two Flow-native products doing things adjacent to RPC's roadmap. Live-walked both (Chrome). Companion to docs/research/competitive-recon-2026-05-30.md — the 05-30 conclusion (squeeze/effective-supply story unclaimed by natives) still holds after this pass.

## Vaultopolis (vaultopolis.com) — "Collectible Analytics, Packs & Liquidity on Flow"

What it is: TSHOT liquidity product (swap any TS Moment 1:1 for a vault-backed TSHOT token; bridge to Flow EVM; redeem for new Moments) + free analytics across Top Shot / All Day / Pinnacle (claims 21,400+ editions; TS 15,587 on the live board) + custody tooling (bulk transfer ≤120, EVM bridge ≤9) + guides.

Analytics depth (the part that matters to us): a Market Pulse header per collection — 7d/30d/3m/6m/1y sales volume ($749K 7d TS), sales count, BUYERS (2,699) vs SELLERS (3,074), market cap ($65.3M), ACTIVE LISTINGS (314K), listed %, MEDIAN FLOOR — plus five discovery boards: Top Purchases (30d), Hottest (7-day momentum score), Trending Up (30d avg vs prior 6mo), Best Value (floor vs their "EV" estimated value — their version of FMV-vs-ask deals), Most Active (7d sales). Portfolio tracking advertises "automated sell signals."

Read on them: strongest at market-macro + momentum discovery and listings depth. Their EV carries NO confidence labeling and no visible methodology — RPC's confidence enums + public FMV methodology page is the honesty differentiator (once the methodology page is actually anon-readable — see audit handoff Item 2). They do NOT touch locks/burns/effective supply, pack EV vs price, per-render Pinnacle, badges/TC, or concierge. Their buyers-vs-sellers split and median-floor stats are genuinely good macro signal we don't surface.

## Top Shot Community Rewards (topshotcommunityrewards.com) — "Top Shot Verifier"

What it is: a READ-ONLY ownership verifier + collector rewards program. Connect with Dapper or any Flow wallet via FCL Discovery; it walks ACCOUNT LINKING · HYBRID CUSTODY to surface every Moment across linked Dapper accounts; "Read-only — you never sign a transaction / We never request signing keys." On top of verification: live challenges (set completion — "Hustle and Show 2023-24 Set Holder", "Own full Bag Works set"; quantity — "Own 2 NAW Playoff Moments"; LOCK-aware — "Own and Lock 5 SGA Bag Works Moments") with per-challenge completion counts, a leaderboard, milestones, treasure/battles gamification, and an on-chain MINT of rewards. Claims 120 verified collectors.

Read on them: this is direct, working validation of the verification approach RPC wants (CLAUDE.md known-issue #0). Their answer to the Dapper-sign-in problem is the one RPC already has infrastructure for: HybridCustody account-link walking (RPC has hybrid-custody-proxy, the linked_accounts table + get_linked_* RPCs, and a 20-min ingest pipeline since May 8). 120 verified collectors is real niche traction and signals collector willingness to verify when the flow is read-only + trust-framed.

## What's worth borrowing (priority order, gates respected)

1. HYBRIDCUSTODY READ-ONLY VERIFY PATH (high leverage, infra exists). Add a second verify path beside the listing challenge: connect self-custody Flow wallet via FCL → walk get_linked_all/HybridCustody → if a linked Dapper child/parent holds the claimed collection, mark verified. Read-only, no listing dance, no Dapper developer access needed. Falls back to the listing challenge for collectors who never linked an account. Echo TSCR's trust copy: "Read-only — we never ask you to sign." This upgrades the rewards verified-wallet gate's CX without being a new rewards build (it's known-issue #0 work).
2. MOMENTUM/DISCOVERY BOARD for /insights (candidate, Trevor's call). Hottest (7d momentum), Trending Up (30d vs prior 6mo), Most Active — all computable from RPC's own sales spine today, and a natural sibling to squeeze/deals/rookies. Differentiate with confidence labels + squeeze context per row (Vaultopolis shows momentum with no supply honesty).
3. MARKET PULSE HEADER on /insights/market: buyers vs sellers count, median floor, listed% — macro stats RPC's sales + offers/ask data can mostly support; listings depth is the one input where Vaultopolis is ahead (RPC TS ask coverage rides badge_editions.low_ask ~86%).
4. CHALLENGE MECHANICS FOR REWARDS (backlog — rewards board is CLEAR until the Monday pulse shows usage). TSCR-style set-completion / lock-aware challenges map 1:1 onto data RPC already indexes (wmc holdings, badge lock events, Team Hub cost-to-complete). When the rewards gate opens, this is the obvious earn-rule expansion; RPC's twist is FMV-aware challenges.

## Explicitly NOT to chase (off-thesis)

TSHOT-style liquidity/vault token, EVM bridging, bulk-transfer custody tooling (transaction products — RPC is intelligence-first, cart/live-buy shelved); treasure/battles gamification and on-chain reward minting (RPC rewards stay off-chain, no chance mechanics).

## Positioning takeaway

Neither product tells the effective-supply story (locks+burns), prices packs against FMV, or labels price confidence. RPC's lane stays open. The two real gaps this recon exposes in RPC are (a) verification friction vs TSCR's read-only linking flow, and (b) no momentum/macro-pulse discovery surfaces vs Vaultopolis. Both are buildable on data RPC already has.
