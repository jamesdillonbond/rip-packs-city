# Candy & Panini — Onboarding Research + Executable Integration Plan

**Date:** 2026-06-08 · **Author:** Cowork research pass · **Mode:** READ-ONLY (nothing shipped; every DB/code/worker step below is *proposed*)
**Scope:** Deep dive on Candy Digital and Panini, their latest moves, public data availability, and a phased, executable plan to add each as an RPC supported collection — mapped onto the completed chain-abstraction work (Phases A–F).

---

## 0. TL;DR / decision summary

| | **Candy Digital** | **Panini (Panini Blockchain)** |
|---|---|---|
| **Verdict** | **GO — near-term, high-fit. This *is* RPC chain two.** | **WAIT — low-fit, blocked, declining. Monitor only.** |
| Chain | **Solana** (Metaplex Core), live migration completing ~today (June 8 2026) | Private **Hyperledger Sawtooth** chain (archived tech) + thin **Ethereum** bridge |
| Public, indexable data | **Yes** — Helius DAS (assets/wallets) + Magic Eden API (sales/listings), Arweave media | **Mostly no** — private chain not directly readable; only CryptoSlam aggregate + a tiny Ethereum-bridged subset |
| Edition/serial schema | **Confirmed on-chain** ("on-chain serial numbers + edition size") | On private chain; not publicly addressable |
| IP / content | MLB (MLB Gems), DC Comics (DC3, Batman Cowls), Getty, Netflix; historically NASCAR/WWE | NBA + NFL **licenses expired** (Oct 2025 / Apr 2026) → Fanatics exclusives; remainder is WNBA/NASCAR/soccer/college |
| Trajectory | Reboot under new owner/CEO Tad Smith; scarcity + secondary-liquidity focus | Revenue projected to collapse $43M (2025) → ~$1.7M (2027); existential platform risk |
| RPC trigger status | All 3 chain-two trigger conditions about to be satisfiable (~July 2026) | None of RPC's data preconditions met |

**Bottom line.** Candy is a clean, well-timed chain-two add that the chain-abstraction work was *literally built for* — the `chain_type` enum already carries `solana`, and `lib/collections.ts` already has a (now-stale) `candy-mlb` placeholder. Panini is the opposite: a private, sunsetting platform whose marquee sports content has lost its licenses and whose only public data is a third-party aggregate. Recommend **executing the Candy plan once secondary trading + 30 days of sales exist (~July)**, and **putting Panini on a monitor-only watch** pending a public-chain remint.

> **Important correction to the existing roadmap:** the `candy-mlb` registry placeholder says *"Reserved for Candy MLB integration on the Root Network"* with `partner: "Futureverse"`. **Both are now stale.** Candy left Futureverse/The Root Network and, under new owner Tad Smith, is migrating to **Solana / Metaplex Core**. This actually makes Candy align *more* cleanly with RPC's "Solana is chain two" thesis than the original plan assumed.

---

## 1. Candy Digital — deep dive

### 1.1 What it is + ownership history

Candy Digital is an officially-licensed premium digital-collectibles brand (sports + entertainment + culture). Ownership has changed hands repeatedly, which matters because each owner reset the chain strategy:

- **2021** — Launched (backers incl. Galaxy Digital / Mike Novogratz, Gary Vaynerchuk, Fanatics early on). Flagship: MLB digital collectibles. Originally minted on Ethereum/Palm.
- **June 2023** — Merged with **Palm NFT Studio** (Palm sidechain / Ethereum L2 lineage), alongside layoffs. Combined entity kept the Candy banner; IP spanned MLB, NASCAR, DC Comics, WWE, Netflix, Warner Bros. Discovery.
- **April 16 2025** — Acquired by **Futureverse** (AI + metaverse company; CEO Aaron McDonald), which folded Candy's IP (MLB, Netflix, DC) toward **The Root Network** (Futureverse's EVM chain). Reported scale at acquisition: **~4M NFTs, ~1.5M accounts**.
- **~May 2026** — New owner/CEO **Tad Smith** (former **Sotheby's CEO**, **Doodles** chairman) took over (~2 weeks before the June 1 relaunch). Tad Smith's reboot = the **Solana migration** described below.

### 1.2 The headline move: migration to Solana (the reason this is timely)

This is the single most important development for RPC and it is happening **right now**:

- **Standard:** **Metaplex Core** (Solana's next-gen single-account NFT standard). Royalty enforcement is embedded at the protocol level via the Core Royalties plugin.
- **Storage:** **Arweave** — images, videos, metadata, and even full DC comic pages are stored permanently/decentralized. (Good for RPC: Arweave URLs are normally directly fetchable, unlike Disney Pinnacle's signed-asset 403 problem.)
- **Wallets:** Candy generates a **self-custody Solana wallet** per fan, importable into **Phantom**. Private-key reveal gated behind 2FA.
- **Secondary trading:** via **supported third-party Solana marketplaces, Magic Eden named explicitly** ("and others to be announced"). This is the sales-data source RPC needs.
- **Primary sales:** Candy.io continues as a storefront; new purchases mint directly to the fan's wallet; **Stripe** integration in progress; drops **and auctions** planned.
- **Asset fidelity:** Candy states *"Your collectibles, rarity, **edition/serial numbers**, and associated metadata will carry over unchanged."* The new product detail pages surface *"decentralized images, videos, metadata, player attributes, **on-chain serial numbers, and edition size information**."* → **This is the defined edition/serial schema RPC requires to index.**

### 1.3 Migration timeline (latest moves, dated)

| Date (2026) | Event |
|---|---|
| Apr 16 2025 | Futureverse acquires Candy (prior era) |
| ~May 2026 | Tad Smith takes over as owner/CEO; announces Solana reboot |
| May 21 | Tad Smith lays out strategy on Sporting Crypto podcast (scarcity, self-custody, royalties, liquidity, auctions) |
| May (mid) → June 8 | Legacy assets **re-minted onto Solana in batches**; "Active Fan" cutoff was **May 20** |
| Jun 1 | **New Candy.io site live** — wallet visibility, per-asset migration progress bars, updated terms |
| **~Jun 8 (today)** | Target: **migration completion** for most eligible legacy assets (speed caveated by Solana throughput) |
| Shortly after Jun 8 | **Secondary trading opens** for legacy assets on Magic Eden + supported Solana marketplaces (private-key reveal → Phantom) |
| ~Jun 16 | Outstanding cash-balance conversion/withdrawal feature |
| ~Jun 22 (week of) | First **new primary sales/drops** once Stripe + infra ready (not final) |

### 1.4 Content lines (candidate RPC collections)

- **MLB x Candy** — baseball cards; "MLB Gems" cited as the strongest format (rookie debuts, milestones, signature plays). MLB is Candy's strongest foundation.
- **DC Comics** — "DC3" comics (full comic viewer, pages on Arweave) + **Batman/"Bat" Cowls** (community/identity collectible).
- **Getty Images**, **Netflix** — entertainment/culture IP.
- Historically: **NASCAR, WWE, Warner Bros. Discovery**.

### 1.5 Strategy read (why it fits RPC)

Tad Smith's stated priorities — **scarcity discipline, secondary-market liquidity, price discovery (auctions), royalty enforcement, self-custody** — are precisely the things an *intelligence* product like RPC serves: FMV, edition/serial scarcity, squeeze/lock analytics, deal-finding, portfolio. A rebooting platform with thin tooling of its own is an ideal target for RPC to be "more useful than the native site."

### 1.6 ⚠️ Disambiguation caveat (do not index the wrong "Candy")

A separate entity, **NxGen Brands Inc. (OTC: NXGB)**, launched a **`$CAND` token on Raydium** ("digital Candy ecosystem on Solana") in March 2026. This is an unrelated fungible-token/penny-stock play — **NOT** Candy Digital's licensed NFTs. When discovering on-chain addresses, filter to **Metaplex Core assets under Candy's verified collection/update authority**, never a token mint named "Candy/CAND."

---

## 2. Panini — deep dive

### 2.1 What it is

**Panini America** (subsidiary of Italy's **Panini Group**, ~$1B group revenue in World Cup years) is the physical trading-card/sticker giant. **Panini Blockchain** (nft.paniniamerica.net) is its digital-card platform.

### 2.2 How Panini Blockchain works (and why it's hard to index)

- **Launched** late 2019 / first drops Jan 2020 (Dutch auctions), then redemption-code + pack-based drops mirroring physical collecting.
- **Underlying chain:** a **private/permissioned Hyperledger Sawtooth** chain (the platform pays out via **PayPal**). **Critical liability:** Sawtooth was **archived upstream** (now "Splinter"), partly for lack of developer interest — Panini must self-resource the chain on AWS. It cannot operate without Panini America funding it.
- **Content:** NFL, NBA, UFC, Soccer trading-card NFTs + unopened digital packs, traded *inside Panini's walls*.
- **Ethereum bridge (opened Mar 30 2026):** lets users move **cards** (not packs) to self-custody Ethereum wallets; **OpenSea named the exclusive on-chain marketplace**; 1:1 escrow (the Panini card is locked while the Ethereum version exists). **At launch only Toikido's "Bad Eggs Prizm" collections (Series 1 & 2)** were bridgeable — a **non-sports** IP. Sports cards were **not** yet bridged.

### 2.3 The license cliff (the existential problem)

- **NBA license expired October 2025; NFL license expired April 2026.** Both went to **Fanatics** (which holds exclusive long-term NBA/NFL/MLB trading-card rights, owns Topps, and reportedly constrained Panini's supply via a GCP Packaging stake).
- **Revenue projection (analyst, CryptoSlam-based):** Panini Blockchain net revenue ≈ **$8.7M (2025, inflated by license-expiry buying frenzy) → ~$4.7M (2026) → ~$1.7M (2027)**. Gross platform volume was ~$43–48M in 2025; ~$166M all-time; ~65k unique buyers. The drop-off accelerates as NBA/NFL drops end.
- **Parent pivot:** Panini Group is now issuing collectibles via **FIFA Collect** (soccer / FIFA World Cup 2026), which itself migrated **off Algorand onto an EVM "FIFA Blockchain"** (announced Apr 2025). Panini America's *remaining* licenses: FIFA, WNBA, NASCAR, NWSL, LIV Golf, PFL, College, Disney, Pro Football HOF, Naismith HOF.

### 2.4 Litigation context

Panini sued Fanatics (federal antitrust, 2023); Fanatics countersued. **No merger** (the "Fanatics buys Panini for its NFT success" theory is dismissed by analysts — "Fanatics doesn't care about NFTs"). Trial not likely before **2027**. A separate consumer antitrust class action was **dismissed** (2026, standing).

### 2.5 Public data availability for Panini

| Source | What it gives | Usable by RPC? |
|---|---|---|
| Panini's private Sawtooth chain | The real secondary market (cards + packs) | **No** without a Panini API/partnership — not publicly addressable |
| **CryptoSlam API** (cryptoslam.io/panini) | Aggregated **secondary** sales volume/txns/top sales (Mark Cuban-backed aggregator) | **Yes, but** third-party-dependent, secondary-only, sourced from Panini's private chain |
| **Ethereum bridge → OpenSea** | Only **bridged** collections (currently Toikido Bad Eggs, non-sports) as standard ERC-721/1155 | **Yes, cheaply** via RPC's existing `evm_*` plane (Reservoir/Alchemy/OpenSea) — but thin + non-sports today |
| FIFA Collect (FIFA Blockchain, EVM) | Panini-Group soccer content | Separate platform/chain entirely; a different project |

### 2.6 Strategy read (why it does *not* fit RPC now)

Panini is **declining, fragmented, and mostly un-indexable**: the valuable sports-card secondary market lives on a private archived-tech chain RPC can't read; the public Ethereum-bridged slice is currently a single non-sports IP; the marquee NBA/NFL content has lost its licenses; and the whole platform carries real shutdown risk by 2027. The only honest near-term play is **CryptoSlam-aggregate ingestion** (weak, derivative) or **waiting for a public-chain remint** (which analysts expect Panini *should* do but has not committed to). Integrating now would burn chain-three effort on a shrinking, blocked target — and violate RPC's never-parallel rule while Candy/Solana is mid-build.

---

## 3. Data-availability & indexing assessment (the technical heart)

### 3.1 Candy on Solana — fully indexable with off-the-shelf infra

**Reads (editions + wallets) — Helius / Metaplex DAS API.** Metaplex Core assets are first-class in the **Digital Asset Standard (DAS) API**, which a DAS-enabled RPC (Helius, Triton, QuickNode) indexes for you (metadata, off-chain JSON, **collection grouping**, and **plugins incl. Attributes/Edition**). No need to scan accounts.

- **All assets in a Candy collection:**
  ```
  POST <das-rpc-url>
  { "jsonrpc":"2.0","id":1,"method":"getAssetsByGroup",
    "params":{ "groupKey":"collection","groupValue":"<CANDY_CORE_COLLECTION_ADDR>","page":1,"limit":1000 } }
  ```
  Returns each asset's `id` (mint pubkey, base58), `grouping` (collection), `content.json_uri` (Arweave metadata), `content.metadata`, `royalty.basis_points`, `ownership.owner`, and `plugins`.
- **A wallet's Candy holdings (portfolio):** `getAssetsByOwner` with the owner pubkey.
- **Serial / edition size:** carried in the Core **Attribute plugin** and/or **Edition plugin**, and mirrored in the off-chain Arweave metadata `attributes[]` (Candy confirms on-chain serials + edition size). DAS returns all of these in one call. *(Exact attribute keys must be confirmed against a live asset — a Phase-0 discovery step.)*
- **Media:** Arweave URIs from `content.json_uri` / `content.files` — directly fetchable for `thumbnail_url` denorm.

**Sales / listings — Magic Eden Solana API (+ Tensor as second source).**
- Magic Eden public API base `https://api-mainnet.magiceden.dev/v2/` — free tier ~120 QPM / 2 QPS; API key for higher limits + authorized endpoints. Key endpoints once the collection `symbol` is known:
  - `GET /collections/{symbol}/activities` — secondary sales/listings/bids (the FMV sales feed)
  - `GET /collections/{symbol}/listings` — live asks (sniper / floor)
  - `GET /collections/{symbol}/stats` — floor, volume
- **Tensor API** (Solana's pro trading marketplace) is a strong second sales/listing source for coverage + cross-check.
- Alternative/raw: **Helius Enhanced Transactions / webhooks** parse NFT sale events directly from chain (marketplace-agnostic) — useful if Candy trades spread beyond Magic Eden.

### 3.2 How Solana fits RPC's schema (from the chain-abstraction inventory)

The chain-abstraction plan already enumerated exactly how each Flow assumption generalizes. Solana fits with **no schema rework** — chain is reached via `collection_id` FK everywhere:

| RPC surface | Flow today | Solana (Candy) |
|---|---|---|
| `collections.chain` (`chain_type` enum) | `flow` | **`solana` — already a valid enum value** ✓ |
| `editions.external_id` (text) | `setId:playId` int-pair | Candy edition key (e.g. `collection:editionId` or a metadata card-id); per-asset mint pubkey lives on the serial row |
| `editions.set_id_onchain/play_id_onchain` (int) | Flow ids | NULL for Solana; Candy ids live in `external_id` + attributes |
| `wallet_moments_cache` (addr text) | Flow `0x`16-hex | Solana base58 owner pubkey; UNIQUE `(wallet,collection_id,moment_id)` stays valid |
| `sales` (sig text, year-partitioned) | 64-char Flow hash | 88-char Solana base58 signature; `marketplace='magic_eden'`/`'tensor'`, `source='solana_das'` |
| `fmv_snapshots` (partitioned, `algo_version` text) | Flow algos | reuse `fmv-recalc` (sales-based WAP); chain-implicit via `collection_id` |
| Worker/proxy | Flow proxies | **new `helius-proxy`** (Solana RPC/DAS) — **own auth secret**, never shares `TS_PROXY_SECRET`/`INGEST_SECRET_TOKEN` |

### 3.3 Panini — the indexing reality

- **Sports cards (the value):** locked on the private Sawtooth chain → **not directly indexable**. Requires a Panini data API/partnership that does not publicly exist.
- **Ethereum-bridged subset:** standard EVM NFTs on OpenSea → indexable via RPC's existing **`evm_*` registry pattern** (the Beezie/Base indexer is the template: `evm_chains`/`evm_nft_contracts`/`evm_nft_transfers` + an `evm-transfers-ingest`-style cron, read via Reservoir/Alchemy/OpenSea). But today this is only Toikido Bad Eggs (non-sports) and thin.
- **Aggregate fallback:** **CryptoSlam API** for secondary sales totals — derivative, not the per-edition/FMV granularity RPC's product needs.

---

## 4. How this maps to RPC's existing architecture

Three things are already in place because the chain-abstraction workstream (A–F, complete 2026-06-01) anticipated this:

1. **`chain_type` enum already includes `solana`** (and `ethereum`, `polygon`, `flow_evm`). No `ALTER TYPE` needed for Candy.
2. **`collection_chains` view + `collections.chain` (NOT NULL, no DEFAULT)** — seeding a Candy row just requires passing `chain='solana'` explicitly.
3. **`lib/collections.ts` already has placeholders** for `candy-mlb` and `panini-blockchain`, and the `ChainType`/`dbChain` two-field model is live. The Candy placeholder only needs **correcting** (Root Network/Futureverse → Solana/Candy Digital) and seeding.

What's **new work** (the part the chain-abstraction plan explicitly deferred as "chain-two concern"): the **Solana indexer architecture**, **Metaplex Core asset model integration**, and the **`helius-proxy` worker**. That's what Section 5 specifies.

**Chain-two trigger status (from CLAUDE.md):**

| Precondition | Status (2026-06-08) |
|---|---|
| Chain-abstraction Phases A–F complete | ✅ Done (2026-06-01) |
| Defined edition/serial schema RPC can index | ✅ Confirmed (Metaplex Core on-chain serial + edition size) |
| ≥30 days of Candy Solana **sales** history | ⏳ Pending — secondary trading opens ~mid-June; 30 days ≈ **~mid-July 2026** (CLAUDE.md "earliest 2026-07-08" holds) |

**Sequencing rule:** Candy is **chain two**. Panini (EVM) would be **chain three** — do **not** parallelize (strategy doc's "never parallel"). Candy ships and stabilizes first.

---

## 5. Executable plan — CANDY (the recommended build)

Phased like the chain-abstraction plan: each step independently shippable, reversible, with a named deploy surface (Cowork MCP for DB/edge-fn; **Claude Code** for route/worker/.tsx per the cowork-deploy-split rule). **Gate the build on ~30 days of live Magic Eden sales (~mid-July).** Phase 0 is read-only and can start now.

### Phase 0 — Discovery & watch (NOW, read-only, zero risk)
- **Watchlist** Candy's secondary-trading open (this week) and start a 30-day sales clock. Optionally a scheduled task to check Magic Eden weekly for live Candy collections.
- **Capture the on-chain anchors** once trading opens (none are public pre-launch):
  - Candy's **Metaplex Core collection address(es)** per IP line (MLB, DC, etc.) — find via Magic Eden collection page → "details", Solscan (search the collection), or a bridged fan wallet's `getAssetsByOwner` → read `grouping.group_value`.
  - Candy's **update authority** pubkey (to verify authenticity and disambiguate from the `$CAND` token).
  - Magic Eden **collection `symbol`(s)** for the activities/listings/stats endpoints.
- **Inspect one live asset** via DAS `getAsset` to nail the **exact serial / edition-size attribute keys** and the stable **edition key** to use for `editions.external_id`.
- **Pick a DAS provider** (Helius recommended — best DAS + webhooks) and provision an API key.
- **Decide collection granularity** (Trevor's call): one `collections` row per IP line (`candy-mlb`, `candy-dc`, …) vs one umbrella `candy` row. Recommendation: **one row per IP line** (mirrors how RPC treats TS/AllDay/etc. and keeps FMV/squeeze per-IP meaningful).
- **Correct the stale registry placeholder** (`lib/collections.ts` `candy-mlb`): `chain`/`dbChain` → solana, `partner` → "Candy Digital", drop "Root Network" pitch. *(Claude Code; still `published:false`.)*

### Phase 1 — `helius-proxy` worker (new auth surface) · Claude Code
- New Cloudflare Worker `helius-proxy.tdillonbond.workers.dev` fronting the Helius RPC/DAS endpoint (keeps the API key server-side; consistent with the proxy-everything pattern).
- **New secret `HELIUS_PROXY_SECRET`** (or reuse the `INGEST_SECRET_TOKEN` Bearer convention) — **its own rotation domain; never share `TS_PROXY_SECRET`**.
- Smoke: a `getAssetsByGroup` round-trip through the worker returns Candy assets.

### Phase 2 — Seed the collection(s) · Cowork MCP `apply_migration`
- Insert `collections` row(s): `chain='solana'`, slug(s) (`candy_mlb`…), name, etc. (chain must be explicit — DEFAULT was dropped in Phase F).
- Add the new UUID(s) to `lib/collections.ts` maps (`SLUG_TO_DB_SLUG`, `COLLECTION_UUID_BY_SLUG`). *(Claude Code.)*
- No new tables needed (reuse `editions`/`sales`/`wmc`/`fmv_snapshots`); decide later whether Candy warrants a parallel `*_editions` table à la Pinnacle (only if its attribute model doesn't fit `editions` cleanly).

### Phase 3 — Editions ingest (DAS) · Claude Code route + cron
- New route `/api/ingest/candy` (or `lib/chains/solana/`): `getAssetsByGroup` over each Candy collection → normalize each Core asset → upsert `editions` (one row per **edition/card design**) and serial rows into `wmc`/moments:
  - `external_id` = Candy edition key; `circulation_count` = edition size; `thumbnail_url`/`video_url` = Arweave; `player_name`/`set_name`/tier from metadata attributes.
  - Each Core **asset = a serial** → `wmc.serial_number`, owner = Solana pubkey.
- Cron via cron-job.org (own stagger slot; keep off the :00 rush per rpc-cron-ops).

### Phase 4 — Sales ingest (Magic Eden + Tensor) · Claude Code route + cron
- `/api/candy-sales-indexer`: poll `GET /collections/{symbol}/activities` (and Tensor) → write `sales` rows (`marketplace='magic_eden'|'tensor'`, `source='solana_das'`, 88-char sig dedup) keyed to `collection_id`.
- Listings → `cached_listings_v2` (`source='magic_eden'`) for sniper/floor.
- Backfill from trading-open date so the 30-day FMV history accrues.

### Phase 5 — Wallet/portfolio reads · Claude Code
- `getAssetsByOwner` → wallet-backfill for Candy (Solana base58 addresses) → `wmc`. Concierge/profile/`/share` become chain-aware via `collection_id` (mostly automatic).

### Phase 6 — FMV · reuse existing engine
- Point `fmv-recalc` at the new `collection_id` (sales-based WAP + confidence). No pricing-logic rewrite (chain-implicit). Watch confidence calibration on a fresh, thin order book early.

### Phase 7 — Surface it · Claude Code
- Flip `published:true` for the Candy collection(s); wire `pages` (overview/collection/market/sniper/packs as data supports); brand accent; OG cards; sitemap; optionally an `/insights` Candy board. Run the `rpc-insights-qa` checklist before any public surface.

**Deploy-surface summary:** Phase 0 = Cowork/read-only + 1 small Claude Code edit · Phases 1,3,4,5,7 = **Claude Code** (workers/routes/.tsx) · Phase 2 = **Cowork MCP** (migration) + small Claude Code edit · Phase 6 = config.

---

## 6. Executable plan — PANINI (conditional / monitor-only)

**Recommendation: do NOT integrate now.** Keep the `panini-blockchain` placeholder `published:false`. Instead, set explicit re-evaluation triggers and a pre-scoped MVP so RPC can move fast *if* the picture changes.

### Monitor triggers (any one flips it to "evaluate")
1. **Public-chain remint announced** — Panini reminting its sports catalog onto a real public chain (the Topps precedent; analysts expect Panini *should* do this before business realities prevent it). This is the unlock that would make Panini properly indexable.
2. **Sports cards bridged to Ethereum** — if NBA/NFL/UFC collections (not just Toikido Bad Eggs) become OpenSea-tradeable, RPC's EVM plane can index them cheaply.
3. **RPC decides to pursue soccer** — via **FIFA Collect** (FIFA Blockchain, EVM) — but that's a distinct platform integration, not "Panini Blockchain."

### If a trigger fires — pre-scoped MVP (cheapest first)
- **Option A (aggregate, fastest):** ingest **CryptoSlam's Panini API** into a read-only insights surface (secondary volume/top-sales). Low effort, but derivative and third-party-dependent — not per-edition FMV.
- **Option B (EVM-bridged, native):** index the Ethereum-bridged Panini collections via the **existing `evm_*` registry** (clone the Beezie/Base `evm-transfers-ingest` pattern; add `'ethereum'`/contract rows; read via Reservoir/Alchemy/OpenSea). Real per-asset data, but only covers what's bridged.
- **Option C (full, blocked):** direct Panini private-chain integration — requires a **Panini data partnership/API** that doesn't publicly exist. Not pursuable unilaterally.
- **Sequencing:** Panini is **chain three at best** — never start it while Candy/Solana is mid-build (never-parallel rule).

### Tiny housekeeping now (optional, read-only-adjacent)
- The `panini-blockchain` placeholder is fine as-is (`openSeaSlug:"paniniblockchain"`); no change needed until a trigger fires. Worth a one-line note that the OpenSea bridge currently carries non-sports IP only.

---

## 7. Risks, caveats & open questions

**Candy**
- **Migration slippage / liquidity** — completion is "targeted ~June 8, not guaranteed"; secondary trading opens after that, then ramps. The 30-day clock can't start until trading is genuinely live, and early order books will be thin (FMV confidence will read LOW/sparse at first — expected, not a bug).
- **Collection-address discovery** — none of Candy's Core collection addresses / Magic Eden symbols / update authority are public pre-launch; Phase 0 must capture them from live data before any ingest can be built.
- **Attribute schema unknowns** — exact serial/edition-size attribute keys and the right stable `external_id` edition key must be confirmed against a live asset (don't hard-code assumptions).
- **Marketplace coverage** — "Magic Eden + others TBA"; if trades fragment across Magic Eden/Tensor/others, prefer Helius enhanced-transaction parsing for marketplace-agnostic coverage.
- **Ownership churn** — Candy has changed owners 4× in 5 years; the Solana strategy is ~2 weeks old under Tad Smith. Build incrementally; don't over-invest before the reboot proves durable.
- **Disambiguation** — never index the NxGen `$CAND` Raydium token (Section 1.6).
- **No traction-gating conflict** — this is data-plane/intelligence work, not monetization; consistent with RPC's "no paywall until 50+ WAU" rule. But weigh it against RPC's own pre-traction state (WAU ~2) — chain two is a *capability* bet, not a user-demand response yet.

**Panini**
- **Existential platform risk** — private chain on archived tech, funded solely by a shrinking Panini America; possible loss of fan access to collections by 2027.
- **License cliff already hit** — NBA/NFL content is the value and it's gone to Fanatics.
- **Data dependency** — any near-term integration leans on CryptoSlam (third party) or a tiny non-sports bridge.

**Read-only confirmation:** This pass shipped nothing — no migrations, no code, no workers, no registry edits. The `lib/collections.ts` correction and every phase above are *proposed*. Candy work should begin no earlier than Phase 0 discovery once secondary trading is live.

---

## 8. Recommended immediate next actions (small, concrete)

1. **Set a watch** on Candy secondary-trading open (this week) + a 30-day sales clock toward the chain-two go/no-go (~mid-July). *(Schedulable as a recurring check.)*
2. **When trading opens (Phase 0):** capture Candy's Core **collection address(es)**, **update authority**, and Magic Eden **symbol(s)**; `getAsset` one live asset to map serial/edition attributes. Provision a **Helius** key.
3. **Correct the stale `candy-mlb` placeholder** in `lib/collections.ts` (Root Network/Futureverse → Solana/Candy Digital), keep `published:false`. *(Claude Code, low-risk.)*
4. **Decide collection granularity** (per-IP rows vs umbrella) — Trevor's call; recommend per-IP.
5. **Park Panini** on monitor-only with the three triggers in §6; revisit only if one fires (and never before Candy is stable).

---

## Sources

**Candy Digital**
- [Candy Collectibles Are Moving to Solana](https://blog.candy.io/candy-collectibles-are-moving-to-solana/) — Candy Digital Blog
- [Candy Collectibles Migration to Solana: What Fans Need to Know (FAQ)](https://blog.candy.io/candy-collectibles-migration-to-solana-what-fans-need-to-know/) — Candy Digital Blog
- [Candy's New Site Is Live: What Fans Can Expect Today](https://blog.candy.io/candys-new-site-is-live-what-fans-can-expect-today/) — Candy Digital Blog (Jun 1 2026)
- [Candy's Next Era: Takeaways from Tad Smith on Sporting Crypto](https://blog.candy.io/candys-next-era-takeaways-from-tad-smith-on-sporting-crypto/) — Candy Digital Blog
- ["IT STARTS TODAY": Candy Digital's Solana Era Officially Begins](https://www.theboredapegazette.com/post/it-starts-today-candy-digital-s-solana-era-officially-begins-with-cards-comics-cowls-and-more) — Bored Ape Gazette (Jun 2 2026)
- [Futureverse acquires NFT startup Candy Digital](https://www.axios.com/2025/04/16/candy-digital-futureverse-mlb-nft) — Axios (Apr 16 2025)
- [Futureverse Acquires Candy Digital, Bringing Iconic Brands to The Root Network](https://www.therootnetwork.com/blog/futureverse-acquires-candy-digital-bringing-iconic-brands-to-the-root-network)
- [Candy Digital Confirms Layoffs, Reveals Merger With Palm NFT Studio](https://decrypt.co/146734/candy-digital-confirms-layoffs-reveals-merger-palm-nft-studio) — Decrypt (2023)
- [NxGen Brands $CAND token on Raydium](https://www.manilatimes.net/2026/03/04/tmt-newswire/globenewswire/nxgen-brands-inc-otc-nxgb-announces-launch-of-cand-token-on-raydium-launchpad-expanding-digital-candy-ecosystem-on-solana/2292610) — *(disambiguation: unrelated to Candy Digital)*

**Panini**
- [Panini Blockchain Bridge to Open for Business (OpenSea exclusive)](https://blog.paniniamerica.net/panini-blockchain-bridge-to-open-for-business/) — Panini "The Knight's Lance" (Mar 27 2026)
- [Let's Have An Adult Convo About Panini Blockchain](https://www.cardaficionado.com/p/lets-have-an-adult-convo-about-panini) — Card Aficionado (viability analysis, Jul 2025)
- [Hybrid Innovations: NFTs and Blockchain Reshaping Sports Cards in 2026](https://athlonsports.com/collectibles/hybrid-nft-blockchain-sports-cards-2026) — Athlon Sports
- [Panini sales volume data / CryptoSlam](https://www.cryptoslam.io/panini)
- [Judge Rules Against Fanatics as Panini Case Gets Rancorous](https://frontofficesports.com/fanatics-panini-licenses-antitrust-lawsuit/) — Front Office Sports
- [Fanatics Wins Antitrust Lawsuit as Trading Card Buyers Lack Standing](https://www.sportico.com/law/analysis/2026/fanatics-trading-cards-antitrust-lawsuit-dismissal-1234888676/) — Sportico (2026)
- [FIFA Collect Will Dump Algorand for Its Own Chain](https://decrypt.co/317139/fifa-collect-nft-dump-algorand) — Decrypt

**Solana indexing infrastructure**
- [Fetching Assets | Metaplex Core (DAS, getAssetsByGroup/ByOwner)](https://www.metaplex.com/docs/smart-contracts/core/fetch)
- [Solana DAS API — Helius Docs](https://www.helius.dev/docs/das-api)
- [Using DAS API for Fetching all NFTs in a Collection — Helius](https://www.helius.dev/blog/solana-dev-101-using-das-to-return-all-collection-assets)
- [Magic Eden Solana API Overview](https://docs.magiceden.io/reference/solana-overview)

**RPC internal (cross-reference)**
- `lib/collections.ts` — registry (existing `candy-mlb` + `panini-blockchain` placeholders; `ChainType` incl. `solana`)
- `docs/migrations/chain-abstraction-plan-2026-05-30.md` — Phases A–F (complete); defers Solana indexer + Metaplex Core as "chain-two work"
- `docs/strategy/multi-chain-thesis-2026-05-30.md` · CLAUDE.md "Chain strategy" (chain-two trigger criteria)

