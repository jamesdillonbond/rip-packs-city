# RPC Packs, reassessed: free packs, not sold ones

**Date:** 2026-09-29 (PT)
**Asked by:** Trevor, 2026-09-29: "Are we able to wrap and create our own packs of the NFTs we support?" and then "do all that [re-measure the market, get a legal read]. We don't need to sell it."
**Base docs:** [repack-drops-feature-scope-2026-06-19.md](repack-drops-feature-scope-2026-06-19.md) (contract spec) and [repack-drops-addendum-2026-07-18.md](repack-drops-addendum-2026-07-18.md) (market + legal as of July).
**Status:** Research only. Nothing built. The ledger's "Declined — do not re-suggest" entry for RPC Packs is Trevor's to edit; this doc does not change it.

_Not legal advice. I'm not a lawyer. §2 summarizes the public rules. It is enough to decide whether a lawyer is needed, not to replace one._

---

## 0. Summary

1. **The paid re-pack market is still tiny, and it has gone quiet.** Vaultopolis has had one new drop since July (Gold Rush, 26 of 30 sold). Nothing has been created since 07-22 and no sale has run since 08-06. Lifetime: **66 non-test packs, ≈ $755 gross.**
2. **Not selling removes the main legal problem.** Gambling needs a prize, chance, and consideration (a payment or something of value) all at once. A free pack has no consideration. It becomes a **sweepstakes/giveaway**, which is legal in every US state with ordinary compliance: official rules, age limits, "void where prohibited", plus registration and a bond in NY and FL if the total prize value is over $5,000.
3. **Our FMV no longer counts against us.** In July, the risk was that RPC's own FMV proves the prize is worth real money. In a free giveaway that is harmless. It only matters for the $5,000 threshold and for prize tax forms.
4. **The legal risk comes back if the packs are only "free" in name.** Pro-only packs, packs that need purchasable points, or packs that need a purchase all bring consideration back. Free has to mean free to everyone on the same odds.
5. **The engineering is smaller than the July estimate, because a free pack needs no contract.** RPC's wallet holds the moments. A claim picks a pack by verifiable randomness, and the hot wallet transfers the moments. The pack is a reveal in the UI, not an on-chain object.
6. **Two things only you can decide:** (a) this makes RPC act on-chain, which amends the "RPC is read-only" rule. (b) RPC pays for the inventory.

---

## 1. Market, re-measured 2026-09-29

The source is Vaultopolis's open API (`data.vaultopolis.com/api/drops`), fetched live through the database's `pg_net` because the sandbox cannot reach it. FLOW/USD comes from CoinGecko over the last 90 days.

| Drop | Created (UTC) | Packs | Sold | Sell-through | Price (FLOW) | Status |
|---|---|---|---|---|---|---|
| 1 Test Drop | 05-07 | 5 | 0* | – | 1 | listed |
| 2 Test Drop 2 | 06-09 | 21 | 0* | – | 5 | listed |
| 3 Finals Pack | 06-13 | 0 | 0 | – | 170 | cancelled |
| 4 Finals Pack | 06-13 | 15 | 12 | 80% | 170 | minted |
| 5 Heat Check | 06-25 | 20 | 20 | 100% | 432 | minted |
| 6 First Class | 07-09 | 0 | 0 | – | 432 | cancelled |
| 7 WNBA First Class | 07-12 | 40 | 8 | 20% | 369.4 | minted |
| **8 Gold Rush** (new) | **07-22** | **30** | **26** | **87%** | **495** | minted; sale 07-30 → 08-06 |

\* The API now reports `soldCount = 0` for the two test drops. In July it reported 5 and 21. Their counters changed, not their history, so the July "66 including tests" and today's "66 excluding tests" are not the same 66.

- **Sold drops only:** 12 + 20 + 8 + 26 = **66 packs**. Revenue is 26,505 FLOW. That is about $365 for drops 4–7 at ~$0.027 and about $390 for Gold Rush at ~$0.030, so **≈ $755 lifetime**.
- **Demand hasn't grown:** the best drop cleared 26. That is barely above July's "~20 per drop" ceiling.
- **The operator seems to have stopped:** no drop has been created in the 69 days since 07-22. That could be a pause or an exit; the API doesn't say which.
- FLOW has traded between $0.026 and $0.031 over the last 90 days (it was $0.031 today).

**What this means:** if the goal were to sell packs, the case is weaker than in July. The goal is to give them away, though, so the paid market is the wrong yardstick. What matters for a free pack is what it costs RPC and what it earns in attention (claims, returning users, shares), not what people would pay for it.

⚠ `external_pack_drops` in our database was last refreshed 2026-07-19 and is missing drop 8. No cron updates it. The numbers above come from the live API, not from that table.

---

## 2. Legal read for a free pack

### 2.1 Why "free" changes the answer

US lottery and gambling law requires **prize + chance + consideration** together. Remove any one and it isn't a lottery. A randomized pack given away for free keeps prize and chance and drops consideration. Legally it is a **sweepstakes**, the same category as every "NO PURCHASE NECESSARY" brand giveaway, including NFT ones (Obey Giant and 100 Thieves both ran NFT sweepstakes under standard official rules).

The NY AG v. Valve case (filed 2026-02-25) targets *paid* loot boxes under the NY Constitution and Penal Law §§ 225.05/225.10. Valve's motion to dismiss (filed 2026-05-21) was still pending as of 2026-09-01. Whichever way it goes, it is about paid boxes. It does not reach a free giveaway.

### 2.2 What a compliant free pack needs

| Requirement | What it means for RPC |
|---|---|
| **Official rules** | Sponsor (RPC), eligibility, start/end dates, prize description and approximate retail value (our FMV works here), odds, how winners are picked, how prizes are delivered, "void where prohibited". Posted before launch and linked from the claim page. |
| **No purchase necessary, with equal odds** | Every claimer gets the same odds whether or not they pay RPC anything. |
| **Age** | 18+ (the Top Shot terms already require it). |
| **NY + FL registration and bond** | Only if **total announced prize value exceeds $5,000** per promotion (NY GBL § 369-e, filed 30 days ahead; FL § 849.094, filed 7 days ahead, plus a bond equal to the prize value). **Keep each promotion under $5,000** or exclude NY/FL residents. At commons-heavy pack values that is thousands of packs, so it won't bind early. |
| **Prize tax** | Report any winner who receives ≥ $600 of prizes in a year on a 1099-MISC. Keep per-person value low and cap claims per account. |
| **IP / affiliation** | Giving away the NFT itself is a transfer, which the Top Shot terms allow. Do not use NBA/NFL/league or player marks in the *promotion* copy beyond naming the moment, and state "not affiliated with or endorsed by the NBA, Dapper Labs, …". |

### 2.3 The ways it becomes paid again (avoid all of them)

- **Pro-only packs.** Pro is a paid subscription, so that is consideration. A Pro perk can be *extra* only if the free path has the same odds and the same prize pool.
- **Packs bought with purchasable points.** Points earned from activity are generally fine. If points can ever be bought, they are consideration.
- **"Buy X, get a pack."** Consideration.
- **Selling or trading packs before they are opened.** An unopened pack NFT that can be listed recreates a secondary lottery market. This favors the no-contract design in §3: there is nothing to trade before the reveal.
- **Heavy required effort.** A few states have treated substantial non-monetary effort as consideration. Signing in and connecting a wallet is not that. A long survey or a paid referral would be.

### 2.4 What still needs a lawyer

For a first run under $5,000 with no purchase path, the table above is standard practice. An hour with a promotions lawyer to review the official rules is cheap and worth it before the first public drop. It is no longer a blocker for building anything.

---

## 3. What "wrap and create our own packs" takes when free

### 3.1 Recommended shape: an RPC-held pool with a verifiable random claim and delivery on transfer

- **Inventory:** RPC's wallet holds the moments for a drop. Publish the full pool list with our FMV before claims open (the transparency the July addendum wanted).
- **Randomness:** assign packs to claims with Flow's on-chain randomness (`RandomBeaconHistory`, already drafted for the VRF shuffle in the breaks code). Alternatively, commit a hash of the pack manifest before launch and reveal the salt afterwards, as Vaultopolis does. Either way anyone can check that RPC didn't pick who got the good pack.
- **Claim:** signed-in user, one claim per account and wallet, recipient is their saved Flow wallet.
- **Delivery:** the hot wallet transfers the pack's moments. The chunked, idempotent transfer code in `app/api/breaks/[id]/distribute` + `BREAK_MULTI_TRANSFER_TS` is the starting point.
- **Reveal:** a pack-opening animation in the UI. No pack NFT exists, so nothing is sellable before it opens (§2.3).

This needs no new Cadence contract, no audit, and no payment code.

### 3.2 A pack NFT, only if you want one later

A real on-chain pack (a resource holding the NFTs, opened by the owner) is the ~3–4 week, audited contract in the June scope doc. For a free giveaway it adds cost and creates a tradeable unopened pack (§2.3). Not recommended.

### 3.3 Which collections

- **Top Shot + All Day:** ready. FMV is deep enough to publish honest pack values, and delivery to Dapper-custodial accounts goes through the public receiver (inferred from 235 wallets in July, not yet proven by a real transfer, see §4).
- **Mixed-collection packs:** the recipient must already have each collection set up in their account, or the transfer fails. Start with single-collection packs, or check every receiver before assigning a pack.
- **Golazos, UFC:** FMV is too thin to publish a value. Pinnacle is priced on a different grain.
- **Candy MLB (Solana):** RPC has no Solana write path. Treat it as a separate program.

### 3.4 What isn't ready (measured today)

- `moment_gifts`: **0 rows.** RPC has never completed a real on-chain transfer through the gift path.
- `break*` tables: **not in production** (migration never applied).
- Payer wallet `0x73f55c4450b8d466`: the July addendum says it must be re-funded and its balance cron un-paused before any Cadence write ships.
- Points shop: 10 items, **1 redemption ever**, 19 users with points.

**Rough effort:** a few days for one Top Shot drop, most of it in the claim page, the randomness and a first real test transfer, not in new infrastructure.

---

## 4. Decisions for Trevor

1. **Amend the read-only rule?** Concierge rule #1 and the product principle say RPC never acts on-chain. Free packs mean RPC transfers NFTs. A narrow carve-out would be: "RPC may give away moments it owns; it still never trades, sells, or custodies user assets."
2. **Inventory budget.** Each drop costs whatever RPC pays for the moments. The pool FMV is published, so the cost is visible upfront.
3. **Who can claim?** Signed-in users with a saved Flow wallet, one per account, 18+, excluding the `internal_accounts` population.
4. **First step if yes:** one real low-value moment sent through the existing transfer path to a Dapper-custodial account. That turns the delivery inference into a measurement, which is the step the July addendum listed first and nobody has run yet.

---

## 5. A repack launchpad (added 2026-09-29, Trevor: "I could also see it be a repack launchpad type of feature")

A launchpad means other people (collectors, communities, creators) build and drop packs of their own moments using RPC's tooling. What decides whether this works is whether each creator's packs are **sold** or **free**.

| Shape | Legal | Custody | Verdict |
|---|---|---|---|
| **Paid random packs by creators** | Every drop is prize + chance + payment. RPC would be *promoting* it, and NY Penal Law § 225.05 names promoting gambling on its own. This is the shelved shape, repeated once per creator. | Creators' NFTs and buyers' money must sit somewhere trusted, so a contract plus payments. | **No.** |
| **Free giveaway packs by creators** | Each drop is a sweepstakes. The compliance in §2.2 applies to each creator, and RPC as the platform should require it: rules template, $5,000 cap per drop, age gate. | The creator's moments go into an **on-chain escrow contract**, and the claimer opens the pack. RPC never holds them. This needs the escrow-in-pack contract from the June spec: ~3–4 weeks plus an audit. | **Yes, after RPC's own free drops (§3) prove the claim and reveal flow.** |
| **Paid transparent bundles** ("these 3 exact moments, FMV $47, price $38") | No chance, so it's ordinary commerce. | RPC becomes a marketplace: bundle listings, settlement, disputes. The on-chain storefront doesn't do multi-NFT bundles natively. | Possible later. It's a marketplace decision, not a pack decision. |
| **RPC as the verifier for anyone's drop** (no hosting) | None. | None. `score_external_pack_drop()` already prices any pool: mean vs median EV, coverage. | Already built. The only operator has been dormant since 07-22, so there's little to verify today. |

**What a free launchpad adds over RPC-only drops:**
- **Creators bring the inventory**, so RPC's inventory budget goes away.
- **Creators bring their audiences.**
- **Every pool gets priced by RPC FMV before it goes live:** a "Verified by RPC" badge with the pool value and a typical-pack value. That's our moat doing the work.

**New problems a launchpad brings:**
- **Claim farming.** Free packs attract multi-account farming. Creators will want gates like wallet age, one claim per Top Shot account, or captcha. ⚠ **"Must hold X to claim" is risky:** if X has to be bought, a lawyer could argue it counts as payment. Keep holder gates out until a lawyer has looked at them.
- **Creator honesty.** Escrow proves the pool exists and is locked. Publishing the pool with RPC FMV before claims open proves what's in it.
- **Moderation.** Creators must not pay claimers, sell unopened claims, or run "donate for extra entries" drops. Put that in the creator terms and enforce it.

**Order:** (1) RPC's own free drop on the no-contract design (§3.1). (2) If claims and reveal land well, the escrow contract and creator-side tools, free drops only. (3) Revisit paid transparent bundles only when the 100-WAU gate is met.

---

## 6. Team and sub-community drops (added 2026-09-29, Trevor: "activating with different team-based communities, or sub-communities within each collection")

### 6.1 The communities are out on the market, not in RPC

- **RPC's own users:** 28 non-internal accounts. **3** have picked a favorite team (Blazers 2, Warriors 1; Seahawks 2, Bills 1; Fire 2, Fever 1). There is no team community inside RPC yet. Team drops would have to *bring* fans in, which suits them as acquisition.
- **The market, last 90 days of `sales`.** Two measures. "Buyers" means anyone who bought that team at least once, and it overlaps heavily because most buyers buy across many teams. **"Loyal fans"** means buyers with at least 3 purchases, at least half of them on one team.

| Collection | Active buyers (3+ buys) | Loyal fans | Teams with 25+ loyal fans | Largest loyal groups |
|---|---|---|---|---|
| Top Shot | 2,066 | 362 across 49 teams (median 5) | 2 | Lakers 32, Spurs 30, Knicks 24, Fever 20, Warriors 17, Raptors 16, Celtics 15, Mystics 14 |
| All Day | 208 | 59 across 25 teams (median 2) | 0 | Bills 7, Cowboys 6, Bucs 5 |
| Candy MLB | 181 | 25 across 10 teams | 0 | Dodgers 6, Yankees 5 |
| Golazos | 9 | 3 | 0 | Barcelona 3 |

Looser cut (a team is at least a quarter of the buyer's purchases): Lakers 78, Fever 79, Fire 49, Blazers 24. Blazers have 9 loyal fans on the strict cut.

Raw team reach is much larger, because the WNBA dominates it right now. Top Shot's top raw teams are Wings 1,070, Mystics 1,068, Storm 1,040, Fever 956 and Sparks 895, against ~2,950 total buyers. Those are mostly broad collectors, not team fans.

Pinnacle's sub-communities are franchises (the `characters`/franchise traits), not teams. They aren't measured here.

### 6.2 What this means

- **Only a handful of teams can fill a drop on their own.** A ~25-pack drop is about what Vaultopolis's best paid drop cleared. Lakers, Spurs, Knicks and Fever (Top Shot) can fill one from loyal fans alone, and a few more can on the looser cut. Every All Day, Candy and Golazos team is too small to go it alone.
- **Two drop shapes that work at today's size:**
  1. **Team drops for the biggest Top Shot fanbases**: a Lakers pack, a Knicks pack, a Fever pack.
  2. **Grouped sub-community drops everywhere else**: a division or conference pack, a "WNBA pack" (the largest raw audience on Top Shot right now), an "AFC East pack" for All Day, a "rookies" pack. Group teams until the loyal-fan pool is at least ~25.
- **Team drops pair naturally with the launchpad (§5).** The people who run a team's collector group (Discord, X) are the obvious creators. They bring the audience and the moments, and RPC brings the claim flow, the pricing, and "Verified by RPC". Dapper's own team-captain communities are the natural co-hosts. ⛔ Per CLAUDE.md, never lead RPC copy or outreach with Trevor's own captain designation.

### 6.3 Rules specific to team drops

- **Anyone can claim.** Theme the *pool* by team, but don't make eligibility depend on owning that team's moments. A holder requirement can count as payment when the qualifying moments have to be bought (§5). A favorite-team pick on an RPC profile is free, so it's fine as a *sort* or a notification target.
- **Team names, no team marks.** Describe the moments ("Lakers moments") and never use logos, "official", or anything implying the team or league endorses the drop. Add the not-affiliated line from §2.2.
- **Price the pool per team.** Top Shot's FMV is deep enough. For All Day and Candy MLB, check coverage per pool and refuse a pool whose value we can't publish honestly.

### 6.4 Pilot

The first RPC-run free drop from §3.1, themed to **one Top Shot team with 25+ loyal fans** (Lakers or Spurs), about 25 packs, pool value published in advance, one claim per account. Measure claims, new sign-ups, and 30-day return. That result decides whether team drops scale out, and whether the §5 launchpad is worth the escrow contract. (Superseded by §7: the pilot is an admin-run giveaway, not an RPC-run drop.)

---

## 7. The concept, clarified: community admins build packs on RPC and give them to their own members (added 2026-09-29)

Trevor: *"we would get the admins from behind these communities to create packs on RPC, that they could then give away to their communities."*

This is the §5 free launchpad, with **community admins** as the creators and **their own members** as the recipients. It changes three things for the better.

### 7.1 What it removes

- **RPC's inventory budget.** The moments are the admin's.
- **Most of RPC's legal exposure.** The admin is the giveaway's sponsor. RPC is a tool, the way Gleam or SweepWidget are for ordinary giveaways. RPC should still require a rules template and forbid paid entry (§7.4).
- **The need for RPC to hold or send anything**, if delivery is signed by the admin (§7.2).

### 7.2 Delivery without custody: this code already exists

`lib/chains/flow/cadence/gift-moment.ts` is a **parent-signed gift out of a Dapper-custodial account**. An admin whose Dapper account is linked to a self-custody wallet (Hybrid Custody) signs one transaction, and the moment moves straight from their Dapper account to the recipient. RPC never holds it, pays for it, or signs for it.

- Dapper's link filter **allows Top Shot, All Day, Golazos and UFC**, and **not Pinnacle** (`docs/research/hybrid-custody-filter-withdraw-probe-2026-07-13.md`, read-only probes).
- ⚠ **It has never run on mainnet.** The probe executed no withdraw, and `moment_gifts` has 0 rows. The first real transfer is still the gating test.
- The transaction moves one moment. A pack needs a batch version (several moments, several recipients, one signature), which is a small change to verified code.
- **Requirement for admins:** a linked self-custody wallet. There are 164 linked Dapper children on chain today, a small group, but community admins are exactly the power users most likely to have one.
- ⛔ The CLAUDE.md HybridCustody ban is about RPC's **hot wallet** only. It says nothing against a user signing through their own linked wallet, which is what this does.

### 7.3 The flow

1. **Build:** the admin connects their wallet on RPC, picks moments from their holdings, and sets the number of packs and moments per pack. RPC shows the pool's FMV and a typical-pack value ("Verified by RPC").
2. **Seal:** RPC shuffles the pool into packs and publishes a hash of the assignment before claims open, so the admin can't steer the good pack to a friend after seeing who claimed.
3. **Share:** the admin gets claim links or codes and hands them out their way: a Discord giveaway, a quiz, first-come, whatever their community does.
4. **Claim:** the member enters a Top Shot address (the receiver check runs first) and sees their pack reveal.
5. **Deliver:** the admin signs one batch transaction delivering every claimed pack, or one per claim. RPC shows each pack's status honestly: *claimed, awaiting the admin's signature* → *delivered* (with tx link). It never shows delivered before the transfer lands.

**The trust gap in this version:** between sealing and delivery the admin still owns the moments and could sell one. RPC re-checks ownership at delivery and shows the result; it can't prevent it. If that matters in practice, the §5 escrow contract closes it: the admin deposits once at sealing and members open their own packs. That's ~3–4 weeks plus an audit, so only build it if the gap is actually a problem.

### 7.4 Rules for admins (creator terms)

- **Free entry only.** No paid Discord roles, Patreon tiers, or "buy my listing" as a way in. Any of those is payment, and a free giveaway becomes a lottery.
- **No reselling unclaimed codes or unopened packs.**
- Keep each giveaway's total prize value under **$5,000**, or exclude NY/FL (§2.2). RPC can enforce this at sealing, because it prices the pool.
- Use team names only, with no logos and nothing implying the team or league endorses it (§6.3).
- RPC provides a one-page official-rules template the admin fills in.

### 7.5 What's left for Trevor

1. **The read-only rule, narrowed:** RPC no longer holds or sends anything. It *prepares* a transfer the owner signs. That's the removed gifting surface in a new form, so it still needs your explicit OK, but the exception is much narrower than §4.
2. **The first test transfer:** send one common moment through the gift transaction from a linked wallet to a Dapper-custodial account. That proves delivery end to end.
3. **A pilot admin:** one Top Shot community (§6: Lakers, Spurs, Knicks and Fever have the largest loyal-fan groups) willing to run a ~25-pack giveaway.

**Effort without the escrow contract:** about 1–2 weeks. The builder UI, sealing and claim links, the batch gift transaction, and delivery status.

---

## 8. Further digging (2026-09-29, 12:40 PM PT): three findings change the plan

### 8.1 Top Shot already has gifting, so RPC can stay read-only

Top Shot has had native gifting since at least 2022. An owner gifts a Moment **by the recipient's username**, or makes a **"GET MY GIFT LINK"** link sent by email, text or chat. Someone without an account creates one to redeem it (Top Shot blog, "Holiday of Hoops: The Gift That Keeps On Giving", 2022-12-24, fetched today). This works from an ordinary **Dapper account**, with **no linked wallet** needed.

That gives a delivery path where **RPC signs nothing, prepares nothing and holds nothing**:

1. The admin builds and seals the packs on RPC (§7.3 steps 1–2). RPC reads their holdings, which it already does for any wallet.
2. Members claim with their Top Shot **username**. RPC resolves it to a wallet with the existing `lib/chains/flow/topshot-username-resolve` (used by allow-list prewarm) and checks the account can receive.
3. RPC gives the admin a **delivery checklist**: "Moment #… → @member". The admin gifts each one **in the Top Shot app**.
4. RPC marks each item delivered **only when the chain shows it arrived**: the recipient holds the moment, sent from the admin's address. The chain-arrival lane (`chain_arrival_probes`: arrival tx, block, sender) already records exactly this for tracked wallets, so the check reuses a working instrument.

**What this does to the open decisions:** the read-only rule **doesn't need an exception**. RPC builds, randomizes, reveals and *verifies*. Moving the NFTs is the owner's own action in Top Shot's own product. That was the biggest blocker in §4 and §7.5.

**The cost:** gifting is manual, one moment at a time. A 25-pack giveaway of 3 moments each is 75 gifts. That's tedious but doable for a monthly event, and the checklist order makes it quick. The linked-wallet batch transaction (§7.2) stays as a later option for admins who want one signature.

**Gift links, a variant to avoid for now:** the admin could make one link per moment and give them to RPC to hand out, which would onboard new collectors with no account. But a gift link is a **bearer claim on the moment**: whoever holds it can redeem it. Storing them makes RPC hold claimable value, which is custody in practice, and a database leak would hand them out. Use usernames. If links are ever used, the admin should send them to winners directly, never through RPC.

**Top Shot terms constraint:** *"if you choose to lock one or more of your Moments, you cannot sell, gift, burn, withdraw, or trade in any Moments that you have locked"*. The pack builder must exclude locked moments.

### 8.2 The admins already exist, and Top Shot already pays them to do giveaways

Top Shot runs an official **Fan Communities / Team Captains** program. There are communities for all 30 NBA teams plus 2 WNBA Captains, each led by community-elected Captains who get a **monthly budget from Top Shot** for events, watch parties, and giveaways. Members get in by completing a **Team Series Checklist** (any Moment of each active player from one season) and connecting their Top Shot account in Discord (Top Shot blog 2022-11-18 and 2023-01-30; `about.nbatopshot.com/community-team-captains`, last published 2026-02-03).

- **The target user is concrete:** ~32 Captains who already run giveaways monthly, often with Top Shot's money. RPC would give them a better giveaway tool: fair and verifiable, with a pack reveal and priced pools.
- ⚠ **Eligibility wrinkle:** those communities are gated by owning a team set, which has to be bought. A giveaway limited to that channel means entrants had to buy moments to enter. Dapper's own program already works this way and it's their exposure, but it's exactly the "must hold X" question from §5 and §6.3. For RPC-run tooling, **offer an open-entry option and default to it**, and have counsel look at gated giveaways before RPC markets them.
- **Go through Dapper, not around them.** Captains are Dapper's program with Dapper's budget. Top Shot's terms bar using a Moment's Art *"to advertise, market, or sell any third party product or service"* without Dapper's written consent. An RPC giveaway page showing admins' moments could be read that way. **A Dapper-sanctioned pilot removes that ambiguity** and brings distribution. ⛔ Per CLAUDE.md, outreach must not lead with Trevor's own captain designation.

### 8.3 What a giveaway costs an admin (Top Shot sales, last 90 days)

| Tier | Sales | p25 | Median | p90 |
|---|---|---|---|---|
| Common | 224,931 | $0.25 | $0.33 | $2 |
| Fandom | 6,605 | $0.40 | $1 | $9 |
| Rare | 35,946 | $5 | $8.54 | $32 |
| Legendary | 3,386 | $65 | $99 | $299 |
| Ultimate | 170 | $325 | $500 | $2,531 |

At median prices, 25 packs of 3 commons cost about **$25**. Add 5 rare "hits" for about **$65**, and one legendary chase for about **$165**. That's **roughly 30× under the $5,000 NY/FL line**, and plausibly inside a Captain's monthly budget. The chase card (one legendary among ordinary packs) is what makes a reveal fun, and RPC's mean-vs-typical pack value (§1.2 of the July addendum) is exactly what an honest giveaway page should show.

### 8.4 Demand evidence: thin, and unmeasured market-wide

- Of the moments tracked into 2 saved wallets by the chain-arrival lane, **78 arrived as non-purchase transfers from 38 distinct senders**, i.e. gifts, trades or giveaway wins. One other saved wallet has **337** gifts recorded via LiveToken activity. **Both samples are tiny** (n = 2 and n = 1 wallets). They show gifting happens; they don't size it.
- **Nothing here measures giveaway demand across the market.** That needs a chain scan of Top Shot transfers that aren't sales, pack deliveries or Dapper internal moves. The chain-arrival lane can't do it: it works backward from what a tracked wallet holds.
- The direct evidence is the Captains program itself: Top Shot funds monthly giveaways across 32 communities.

### 8.5 The plan, revised

1. **Sound out Dapper's community team.** "A free, fair, verifiable pack-giveaway tool for Captains; RPC never touches the moments." Get their OK on the Art/terms question and, ideally, a pilot Captain.
2. **Build the read-only version:** builder (excluding locked moments), seal with a published hash, claim by username, reveal, delivery checklist, and delivery verified on chain. No Cadence, no signing, no custody, no read-only exception. **About a week.**
3. **Pilot with one Captain** (a large community: Lakers, Spurs, Knicks, Fever). Measure claims, new RPC sign-ups, 30-day return, and how long the admin takes to deliver 75 gifts.
4. **Only if manual gifting is the bottleneck:** the linked-wallet batch transaction (§7.2). That needs the first real mainnet test and the narrow read-only exception.
5. **Only if admins not delivering becomes a real problem:** the escrow contract (§5).

## 9. A real pack (2026-10-03, Trevor: "Would we ever be able to do an actual pack?" → "Do it all")

**Shipped first, no contract:** the claim page now shows a sealed pack the claimer opens card by card, lowest value first and the chase card last (`app/giveaways/[slug]/PackRevealClient.tsx`). It is presentation only; the pack was dealt and fingerprinted at sealing.

**The Dapper question, measured (read-only mainnet script via pg_net, 2026-10-03):** 21 Top Shot accounts (20 sampled from `wallet_usernames` + Trevor's) hold **100+ NFT collection types from dozens of contract accounts**, many third-party (FLOAT, MFL, Gaia, Flovatar, FlowtyWrapped, Seussibles…). So these accounts *can* hold new types. The chain can't show which are Dapper-custodial or whether each type needed Dapper's approval.

**The contract sidesteps it:** `cadence/contracts/RPCGiveawayPacks.cdc` (DRAFT, NOT deployed). A pack is not a token in the winner's account. It lives in the contract and opens straight into the winner's EXISTING collection, so:
- a custodial account needs no new collection set up;
- an unopened pack can't be listed or traded (the lottery-shaped design §2.3 rules out).

How it works:
- **seal:** the sponsor moves 1–50 same-type NFTs in; they leave the sponsor's account then.
- **assign:** only the sealing sponsor can name the winner, and only once.
- **open:** anyone can trigger it, but the NFTs can only go to the winner.
- **reclaim:** for an unassigned pack, or an assigned one unopened for 30 days.
- **No admin and no drain path.**

Tests: `cadence/tests/RPCGiveawayPacks_test.cdc` has 11, and they gate CI. Planted defects (sponsor check removed, reclaim delay removed) are caught.

**Before mainnet (Trevor's call):**
1. An external audit.
2. A dedicated deploy account; consider revoking its keys after the audit, so the rules can't change under a sealed pack.
3. A seal transaction through Hybrid Custody, the same legs as Deliver all.
4. Wire `open` into the claim flow. Who pays the open fee (the sponsor in Deliver all, or an RPC key) widens the read-only exception if it's RPC.
5. Pack contents are public on chain from sealing. Fairness rests on the claim drawing a random unclaimed pack, and `claim_giveaway_pack` already does (`ORDER BY gen_random_uuid() LIMIT 1`, checked 2026-10-03). Keep it that way: a claim that let people choose a pack number would let them pick the chase.

## 10. Plan: winners claim with Flow Wallet, not Dapper (Trevor, 2026-10-03)

> "Let's plan on using Flow Wallet to claim instead of Dapper for now, as Dapper likely needs approval."

**Why it fits.** RPC has no Dapper sign-in because Dapper needs developer approval RPC doesn't have (the 2026-08-08 rule pinned by `__tests__/no-client-wallet-connect.test.ts`). Flow Wallet is self-custody and needs no approval. FCL already connects it on `/admin/giveaways`, through discovery or WalletConnect, and it worked on 10-03.

**The flow with the `RPCGiveawayPacks` contract (§9):**
1. **Seal** (sponsor, Flow Wallet via Hybrid Custody): moments go from the sponsor's Dapper account into the contract's packs.
2. **Claim** (winner): sign in to RPC as today, connect Flow Wallet, and claim. RPC draws a random unclaimed pack. The winner's connected Flow Wallet address is the recipient, so there is no typed address and no typo.
3. **Assign** (sponsor): batch-assign claimed packs to their winners. One approval per batch, like Deliver all.
4. **Choose, then open** (winner, signs in their own Flow Wallet). Before opening, the claim page asks where the moments should go (Trevor, 2026-10-03: "an option before opening the pack that allows them to have the moments flow directly to their linked dapper wallet instead of to their flow wallet"):
   - **My Flow Wallet.** The open transaction also sets up a Top Shot collection there if missing.
   - **My linked Dapper account.** Offered only when the page reads (view-only, Hybrid Custody) that the connected Flow Wallet is a parent of a Dapper account. The moments land straight in Top Shot.

   The reveal on the claim page IS the `openAs()` transaction. The contract checks the signer is the pack's winner and sends the moments where the winner signed for. The winner pays the fee (Flow Wallet usually sponsors it) and RPC signs nothing, so **the read-only exception does not widen**. For liveness, anyone may open a still-sealed pack after a 14-day grace period, but only to the winner's assigned address. Until then, nobody can take the choice (or the reveal) away.

**Decisions this needs (Trevor):**
- **Wallet connect on a public page.** The claim page becomes the second place FCL connects a wallet, and the first for non-admins. The guard grows one named exception (claim page, Flow Wallet only). The Dapper reason behind the rule stays intact.
- ~~Where the moments land~~ **Decided 2026-10-03: the winner chooses at open**, between their Flow Wallet and their linked Dapper account (step 4). The contract supports it (`openAs`, tests `testWinnerMayDirectTheMomentsToTheirLinkedAccount`, `testOnlyTheWinnerCanOpenAs`, `testNobodyElseOpensBeforeTheGracePeriod`). **Expected, not yet verified:** moments left in a Flow Wallet don't show in the Top Shot app or marketplace, so the page should say so beside that option.
- **Contract go-ahead.** Still the §9 gate: audit, dedicated deploy account, deploy.

**Until the contract is deployed**, today's v1 (claim by Top Shot username → Deliver all into the Dapper account) keeps working unchanged.

## Sources

- Vaultopolis drops API (live, 2026-09-29, via `pg_net`); CoinGecko FLOW/USD 90-day chart.
- [New York Targets Valve's Loot Boxes as Illegal Gambling (Nat'l Law Review)](https://natlawreview.com/article/new-york-targets-valves-loot-boxes-illegal-gambling)
- [Valve files motion to dismiss (gHacks, 2026-05-21)](https://www.ghacks.net/2026/05/21/valve-files-motion-to-dismiss-new-york-counter-strike-loot-box-lawsuit-compares-item-cases-to-baseball-cards/)
- [New York and Washington Take On the Final Boss of Loot Boxes (FKKS)](https://technologylaw.fkks.com/post/102mnkh/new-york-and-washington-take-on-the-final-boss-of-loot-boxes)
- [How to Legally Run a Contest, Giveaway, or Sweepstakes in the USA (KickoffLabs)](https://kickofflabs.com/blog/usa-giveaway-sweepstakes-laws/)
- [A Primer for The Legality of Loot Boxes (Nat'l Law Review)](https://natlawreview.com/article/legality-loot-boxes-primer)
- [Sweepstakes Registration and Bonding Requirements (Klein Moynihan)](https://kleinmoynihan.com/sweepstakes-registration-and-bonding-requirements-2/)
- [Florida Game Promotions/Sweepstakes (FDACS)](https://www.fdacs.gov/Business-Services/Game-Promotions-Sweepstakes)
- [Be Careful with NFT Giveaways (Robert Freund Law)](https://robertfreundlaw.com/los-angeles-false-avertising-litigation-attorney/be-careful-with-nft-giveaways/)
- [NFT / Puzzle Giveaway official rules (Obey Giant)](https://obeygiant.com/nft/sweepstakes-official-rules/) · [NFT Giveaway Terms (100 Thieves)](https://100thieves.com/pages/nftrules)
- [NBA Top Shot Terms](https://nbatopshot.com/terms) — Art license §(v)–(vi) and locking clause read 2026-09-29
- [Holiday of Hoops: The Gift That Keeps On Giving (Top Shot blog, 2022-12-24)](https://blog.nbatopshot.com/posts/holiday-of-hoops-gift-giving) — fetched via `pg_net` 2026-09-29
- [Fan Communities, Team Captains and the NBA Top Shot Experience (Top Shot blog, 2022-11-18)](https://blog.nbatopshot.com/posts/fan-communities-team-captains-nba-top-shot-experience)
- [Join Your NBA Top Shot Fan Community (Top Shot blog, 2023-01-30)](https://blog.nbatopshot.com/posts/join-your-nba-top-shot-fan-community)
- [NBA Team Captains (about.nbatopshot.com)](https://about.nbatopshot.com/community-team-captains)
