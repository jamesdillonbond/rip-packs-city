# RPC Rewards Program — Strategy & Design

**Date:** 2026-06-04 · **Author:** Cowork pass (for Trevor) · **Status:** Proposal, decision-grade (not build-ready)
**Decision asked:** *Can we roll out a rewards program — points earned by users, spent on prizes (Top Shot Moments + gifts) in a shop — and can we get Flow / Top Shot to fund prizes later?*

---

## 1. Verdict

**Yes — and it's the right *kind* of thing for RPC to build right now.** Three reasons:

1. **The foundation already exists.** RPC has identity (`user_profiles`), an achievements framework (`achievement_definitions` + `profile_achievements` with tiers and a `progress` jsonb), a Pro concept (`pro_users`), wallet verification (`saved_wallets.verification_method`), a hot wallet, and — notably — you already scaffolded the exact two-number points model in `rtr_user_state` (`reported_total_points`, `reported_spendable_balance`, `current_tier`). What's missing is narrow: a points ledger, a shop, a redemption record, and a prize-fulfillment path.

2. **It does not break your "no monetization before traction" rule.** A rewards program is the *opposite* of a paywall. Points are free to earn; this is an **acquisition + retention engine**, not a revenue mechanism. Your documented bottleneck is funnel/distribution and retention, not product quality — a rewards loop attacks exactly that. It can be one of the things that *gets you* to 50 weekly actives, rather than something you wait until 50 WAU to ship.

3. **A direct competitor already proves a non-Dapper tool can run this.** Hardcourt.io — a third-party app on top of Top Shot, the same position RPC occupies — runs a full credits→real-Moment-prizes economy with a tiny team. The model is validated.

**Two cautions that shape the whole design:**

- **Sequence it lean.** At 10 user profiles and 0 weekly-actives, building a full Hardcourt-style economy (seasons, leagues, gacha, wagers) would be retention machinery with no one to retain. Ship a small off-chain MVP, prove the loop, then add depth. (Detail in §5–6.)
- **There is one real legal landmine** — points-for-prizes can become a regulated sweepstakes/gambling question. It's designable-around, but it has to be designed around from day one (§7, risk 1). *I'm not a lawyer; treat that section as a flag, not advice.*

---

## 2. What the three reference programs actually do

| | **Flow Rewards** (1st-party ecosystem) | **Road to the Ring** (Top Shot / Dapper) | **Hardcourt.io** (3rd-party tool — your position) |
|---|---|---|---|
| **Earn by** | Engaging partner apps (Keys from collectible/gaming apps incl. Top Shot, AllDay, Flowty; Boxes from DeFi) + social quests (daily check-in, follow, refer, share) | Buying packs, locking Moments, completing quests, playing Fast Break, making picks — time-boxed to the playoffs | Daily fantasy lineups, login streaks, quests, referrals (100 BC), free-contest finishes (1st = 200 BC), surveys (500 BC) |
| **Currency model** | Box + Key → combine into Points (1 box + 1 key = 5 pts) | **Two numbers:** Playoffs Points (lifetime, sets tier, never drops) + Spendable Balance (earn & spend). 6 tiers. | Baller Credits (BC) = spendable; XP/Season tiers = status via battle pass |
| **Redeem for** | Top Shot/AllDay packs, electronics, merch, experiences, **sweepstakes entries from as little as 1 point** | Exclusive points-only store: signed/game-worn memorabilia, merch, packs — released in waves, headline grails unlock per round | Shop of **real Top Shot Moments** across tiers, lineup upgrades, cosmetics; "Training Camp" gacha (submit 5 Moments → curated reward pool); Leagues pay BC + real Moments |
| **Who funds prizes** | Flow Foundation (ecosystem incentive budget) | Dapper / Top Shot (1st-party inventory) | **Themselves** — sourced via a Trade-In desk (buy users' unwanted Moments for BC) + Shop restocks. Bootstrapped. |
| **How they monetize** | Indirect — drives on-chain activity across the ecosystem | Drives pack sales + the "Lock-In" deposit match | Season pass ($4.99) + Hardcourt **Pro** analytics sub ($4.99→$9.99/mo) |

### What to steal (and from whom)

- **From Road to the Ring — the two-number system.** This is the single best pattern in the space. *Status points* only go up and define your tier (permanent — you can never drop a rank); *spendable balance* is the currency. The result: a user can drain their whole balance on a prize and their status is untouched, so **spending never feels like loss**. You already modeled this in `rtr_user_state` — adopt it natively. Also steal **"picks can't lose points"** (wrong guess refunds the stake): engagement with zero downside.
- **From Hardcourt — the third-party operator playbook.** They are not Dapper and neither are you. Steal: (a) the **Trade-In desk** — buying users' unused Moments for credits both *sources your prize inventory* and *creates a credit sink* in one mechanic; (b) **zero-marginal-cost prizes** (cosmetics: profile borders/banners/effects) that cost nothing to mint but drive status; (c) **constant retuning** — their changelog shows they re-balance earn rates weekly, so build earn rules as editable config, not hardcoded; (d) **Pro analytics as the monetization layer** — and here you're *ahead*, because RPC's FMV/squeeze/rookies/pack-EV intelligence is already better than Hardcourt's "Pro" tools.
- **From Flow Rewards — the sweepstakes primitive** (the partner-app path is stale — see §6). Steal **sweepstakes entries priced from 1 point**: one prize serves many entrants, the cheapest possible way to dangle a grail. ⚠️ Note: the Flow Community Rewards *store* itself is dormant ("Season 1 — End — Intermission," ~8 months quiet as of 2026-06-04), so "become a Keys-earning partner app" is **not** a live channel — the real partner-funding path is now Flow **grants** + direct Dapper (§6).

---

## 3. The strategic case — why this fits RPC *now*

RPC's edge is **intelligence** (FMV, squeeze, rookies, pack EV, wallet analytics). The trap with a rewards program is letting it become a separate product that competes with the core for your attention. The fix is to **make the intelligence surfaces the earning surface**: you reward the exact behaviors that make RPC valuable and sticky.

- Link & verify a wallet → points. (Onboarding + your sybil gate in one.)
- Check the squeeze board / run a wallet scout / build a watchlist → points. (Drives core usage.)
- Complete a "scouting" quest built on RPC data ("find a Moment trading below FMV", "scout 3 wallets", "track a set to completion") → points.
- Refer a collector who links a wallet → points. (Your acquisition flywheel — and the highest-leverage earn action for a pre-traction product.)

So the rewards loop *reinforces* the core product instead of distracting from it. Every point earned is a user getting more value out of your intelligence.

---

## 4. The RPC model (recommended)

**Name.** You already have an "RPC Score" notion (`saved_wallets.cached_rpc_score`). Lean into it:

- **Status = RPC Score** (lifetime, only goes up) → tiers. Basketball-flavored, on-brand: **Rookie → Role Player → Starter → All-Star → Franchise** (tune thresholds later).
- **Spendable = Credits** (working name — alternatives: "Rip Credits", "Pack Bucks"). This is what the shop runs on.

**Earn (bootstrap-cheap, anti-farm).** All rules live in a config table so you can retune like Hardcourt does. Server-validated only — never trust a client claim. Starter set:

| Action | Type | Notes |
|---|---|---|
| Link + verify first wallet | One-time | Gate higher-value redemptions on this |
| Complete profile / set favorite team | One-time | Reuses `profile_bio`, `user_favorite_teams` |
| Daily visit / active streak | Daily, capped | Small; streak bonus |
| Use a core intelligence surface (squeeze, scout, watchlist) | Capped/day | Rewards retention behaviors |
| Rotating quests (built on RPC data) | Weekly | The fun layer; ties to intelligence |
| Refer a collector who verifies a wallet | Per referral | Acquisition flywheel; verify-gated vs. sybil |
| Map existing achievements → Credits | One-time backfill | `achievement_definitions` already exists |

**Spend — the Shop (bootstrap-cheap prizes, per your call):**

- **Pro time** — grant a month of RPC Pro for Credits. You already have `pro_users`; this is a **zero-marginal-cost sink** and a great one (it also funnels users into your eventual paid tier).
- **Cosmetics** — profile borders / banners / accent themes (`profile_bio.accent_color` exists). Near-zero cost, pure status, proven by Hardcourt.
- **Sweepstakes entries** — Credits buy entries toward one headline grail (one of your own Moments). Cheap because one prize serves many entrants. *Run as a no-purchase-necessary sweepstakes with written rules* (§7).
- **Direct Moments** — a small stock of low-cost Commons + a few of your own Moments, redeemed outright. Manual fulfillment (you send from the hot wallet, mark the redemption fulfilled). At 10–50 users this is trivial and the personal touch is a feature.

**Balance the economy.** Credits sink through the shop, Pro grants, and raffle entries; status never sinks (permanence is the point). Cap daily earn, consider per-season credit expiry, and model issuance against prize cost so you never owe more prizes than you can fund.

---

## 5. Architecture — what to build (off-chain MVP)

Keep v1 **fully off-chain**. The Cart / Trade Hub / Cadence-write paths are shelved and the payer wallet is intentionally empty — v1 deliberately does **not** revive them. Prize fulfillment is **manual** (a human sends the Moment), which is correct at this scale.

**New tables (4–5):**

- `points_ledger` — append-only: `user_id`, `delta`, `reason`, `ref`, `created_at`. Source of truth; spendable balance = `SUM(delta)`. Lifetime status = `SUM(delta) WHERE delta > 0` (or a separate maintained column). **Treat this like money: service-role writes only, never client-writable.**
- `points_rules` — `action_key`, `credits`, `cooldown`, `daily_cap`, `active`. Editable config.
- `shop_items` — `id`, `name`, `type` (`moment | pro | cosmetic | raffle | merch`), `cost_credits`, `stock`, `status`, `metadata` jsonb (`edition_id`, `serial`, etc.).
- `redemptions` — `id`, `user_id`, `shop_item_id`, `cost`, `status` (`pending | fulfilled | cancelled | refunded`), `fulfillment` jsonb (`tx_hash`, `moment_id`, shipping…), `created_at`, `fulfilled_at`.
- `raffle_entries` *(if raffles)* — `user_id`, `item_id`, `credits`, `created_at`, plus a draw record.

**Reuse what exists:** `user_profiles` (identity), `profile_achievements` + `achievement_definitions` (achievement→points bridge), `saved_wallets` verification (sybil gate), `pro_users` (Pro-as-prize), hot wallet `0x3aa11c84d776838f` (manual Moment fulfillment).

**Security (matches your existing posture):** RLS on every new table; `anon` gets SELECT-only on `shop_items`; the ledger and redemptions are service-role only. Every earn event is server-validated — the client never asserts "I earned this." A points balance is real value; the threat model is the same as money.

**Surface:** one `/rewards` page — balance + tier, the earn list (what's available + progress), and the shop. A small admin view to fulfill redemptions.

---

## 6. Phased rollout

- **Phase 0 — now (no code).** Approve the lean shape. Pick the name, the 5–8 earn actions, and 3–5 starter prizes (1–2 of your own Moments + Pro time + cosmetics + one sweepstakes grail).
- **Phase 1 — MVP (off-chain).** Ledger + rules + `/rewards` page + manual fulfillment. Reward behaviors you already have. Invite the ~13 allow-list + ~44 saved-wallet users. **Goal: prove the loop** — measure earn rate, redemption rate, and whether it lifts return visits. *This is the whole point of Phase 1; don't over-build past it.*
- **Phase 2 — depth (once there are users to retain).** Intelligence-based quests, referrals, streaks, seasons, and the **Trade-In desk** (inventory + credit sink). This is where Hardcourt-style richness comes in — earned, not front-loaded.
- **Phase 3 — partner + monetization-adjacent (only after 50 WAU, per your rule).** Season pass, Pro-as-reward loop.

**Partner path (runs in parallel, starts once the loop has a few weeks of data):**

> ⚠️ **Correction (2026-06-04):** Flow Community Rewards (the boxes/keys rewards *store*) is **dormant** — `rewards.flow.com` shows "Season 1 — End — Intermission" and has been quiet ~8 months. Do **not** plan around it as a near-term prize channel. The viable channels below replace it.

1. **Flow Grants — the active money.** Flow's funding moved from the rewards store to grants: **Flow GrantDAO** (ecosystem builders, up to ~50k FLOW per round) and the milestone-based **Ecosystem Grants** track for more mature teams (part of Flow's $725M ecosystem fund). RPC is exactly the kind of consumer app/tool these fund — a grant can underwrite prizes *or* development. This is more durable than the rewards store ever was.
2. **Direct Dapper / Top Shot.** Pitch Top Shot / Dapper for prize contribution using two assets they care about: your official **Portland Trail Blazers Team Captain** designation, and **a working loop with real engagement numbers**. Pitch with proof, never empty.
3. **Ecosystem partners.** Flowty (CEO Mike Levy / CTO Austin Kline are aware of and supportive of RPC) and other Flow sports/IP apps for co-funded prize pools / cross-promo.

(Per your standing rule, no public partner/multi-chain talk until you say go.)

The sequencing insight: **the way you "earn" partner-funded prizes is to first prove you can run the loop cheaply yourself.** Bootstrap-cheap isn't just the frugal option — it's the thing that makes the grant application and the Dapper pitch credible.

---

## 7. Risks & how to defuse

1. **Legal — sweepstakes / gambling (the big one).** Prizes + chance + "consideration" can constitute a regulated sweepstakes or lottery; wagering Moments for money-value (Hardcourt's "Moment Wagers" is legally spicy) is riskier still. **Defuse:** no purchase necessary / free alternate method of entry; reward skill & engagement, not money wagering; run raffles as no-purchase-necessary sweepstakes with written rules and eligibility; avoid money-in/money-out. Get a lawyer's eye before scaling real-money-value prizes. *Not legal advice.*
2. **Sybil / farming.** Fake accounts farm dailies and referrals for prizes. **Defuse:** gate earning (and especially high-value redemptions) on a **verified wallet that holds real Moments**; cap daily earn; rate-limit referrals.
3. **Prize-cost runaway.** Issued credits are a liability; over-issue and redemptions outrun your prize budget. **Defuse:** model issuance vs. prize cost, cap earn, season resets, and **prefer zero-marginal-cost prizes** (Pro time, cosmetics, sweepstakes) over direct Moment giveaways.
4. **Distraction from the core.** The rewards program is a *means to retention*, not the product. **Defuse:** keep the MVP lean and build earning **on** the intelligence surfaces so it reinforces core usage instead of competing for build time.
5. **Operational load.** Manual fulfillment is fine at 10–50 users, painful at 1,000. **Defuse:** automate fulfillment only when volume justifies it; until then, manual is a feature.

---

## 8. Recommendation / next step

Roll it out — but as the **lean off-chain MVP**, prizes **bootstrapped cheap**, with the partner pitch treated as a milestone you unlock by proving the loop. It fits the pre-traction moment because it's an acquisition/retention lever (not the tabled paywall), it reuses infrastructure you already have, and it makes your intelligence product stickier rather than competing with it.

If you want, I can turn this into a **build-ready spec + Claude Code handoff** next: the migration for the 4–5 tables (RLS + grants), the `/rewards` route and server-validated earn endpoints, the rules config, and the admin fulfillment view.

---

### Sources

- Flow — How boxes and keys work in Flow Rewards: https://flow.com/post/how-boxes-and-keys-work-in-flow-rewards
- Flow — Rewards Season 1 Is Here: https://flow.com/post/flow-rewards-season-1-is-here
- Flow — Community Rewards Makes Flow the Best Place to Launch Apps: https://flow.com/post/community-rewards-makes-flow-the-best-place-to-launch-apps
- Flow — How to Redeem Your Flow Rewards: https://flow.com/post/how-to-redeem-your-flow-rewards
- NBA Top Shot — 2026 NBA Playoffs on Top Shot (Road to the Ring): https://blog.nbatopshot.com/posts/2026-nba-playoffs-on-top-shot
- Hardcourt.io — landing + Updates changelog: https://hardcourt.io/ , https://hardcourt.io/updates
- Flow Rewards status (dormant, verified 2026-06-04): https://rewards.flow.com/ shows "Season 1 — End — Intermission"
- Flow grants (the live partner-funding channel): https://flow.com/flow-grants , https://developers.flow.com/ecosystem/developer-support-hub/grants
- RPC database (project `bxcqstmqfzmuolpuynti`) — schema + counts pulled live 2026-06-04: existing identity/achievements/Pro tables, 10 user_profiles, 0 weekly-active, no points ledger/shop yet.
