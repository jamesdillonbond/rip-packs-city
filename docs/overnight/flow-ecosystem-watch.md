# Flow Ecosystem Watch — running log

Weekly READ-ONLY external-intelligence sweep for RPC. Beat = the OUTSIDE world (new marketplaces, contracts, standards, execution venues, IPFS expansion) for the Flow collections RPC tracks — complements `rpc-daytime-monitor` / weekly-health, which watch RPC's own pipelines. Design + rationale: `docs/strategy/flow-onchain-intelligence-2026-06-09.md`; dapper.market recon: `docs/research/dapper-market-recon-2026-06-08.md`.

Each entry records what was checked + found so the next run has a baseline and doesn't re-report known items. Newest first.

---

## 2026-06-24 — one actionable item (Dapper pinned more Top Shot media on-chain → run the IPFS catalog refresh). No new venue / marketplace / contract.

Verdict: nothing clears the competitive-threat / new-venue escalation bar. **One positive ecosystem development with a concrete action:** Dapper pinned additional Top Shot media on-chain ~06-21/22 (WNBA tripwire fired) → recommend running `scripts/refresh-ipfs-catalog.mjs` so RPC's catalog/badges/pin-exports pick up the newly-pinned media. Two product-cadence items to carry (NFL next-gen, Pinnacle Legendary drop). Baselines updated below.

**1. Ecosystem / web sweep**
- **WNBA / Top Shot IPFS pin progress (the actionable one)** — the daily art cron's `resolver_misses` dropped from the flat **28** baseline (06-18→20) to 22 (06-21), **1 (06-22)**, then settled at **14** (06-23, 06-24). A clear step-down = Dapper pinned ~14 more editions' media on-chain (`getCIDs` now resolves them; likely the WNBA sets). Daily `topshot-onchain-art-backfill` green every day. **Action: run `scripts/refresh-ipfs-catalog.mjs`** (IPFS_LOADER_TOKEN from the `ipfs-catalog-loader` edge fn) so `topshot_ipfs_assets` + verified-media badges + pin-exports absorb the new media.
- **Disney Pinnacle "Legendary Edition" drop** sold out (40 Legendary Mystery Capsules $499.99; 1-of-1 "Apex" Donald Duck $7,500; ~16K capsules unboxed). Corroborated in RPC data (§3): Pinnacle secondary volume spiked **~3–5x from 06-19** (367–774 sales/day vs ~50–160 before). RPC's `pinnacle_sales` pipeline is capturing it — not blind. Product cadence, not a venue/contract. Pinnacle is also confirmed for **D23 (Anaheim, Aug 14–16 2026)**.
- **NFL All Day next-gen** — pause (since 05-14) reframed: Dapper signed a **new NFL licensing deal**, will reveal the next-gen product **"closer to the start of next season"** (≈Aug/Sept), and added a **"Founding Collector" label + 5% Dapper-balance rebate** for existing holders. Carry: if a new NFL contract/collection ships, it's a new thing to index.
- **NBA Top Shot class-action — tentative ~$4M settlement** (the securities suit). Legal only; no contract/venue/product impact. Context.
- **No new Flow marketplace or aggregator.** Flowty still dead for RPC's collections; Flowverse/TopExpo pre-existing. (Tangential: Japan's 24Karat vending-machine collectibles network — not a marketplace for RPC's collections.) **No dapper.market feature change found** via web (not live-crawled this run): still presumed 3 collections (TS/AllDay/Golazos), no Pinnacle/UFC, no unified search, no analytics/FMV tab. RPC moat intact.
- Forward-looking (carry): the 06-12 TS IPFS PR reiterated Dapper "plans to embed IPFS CIDs directly into on-chain Edition Metadata on Flow" — not yet shipped; would be a new on-chain media source RPC could read directly. Still **TS-only** scope, no AllDay/Pinnacle IPFS extension announced.

**2. IPFS expansion tripwires**
- (a) **No new AllDay/Pinnacle IPFS resolver.** AllDay acct `0xe4cf4bdc1751c65d` → `AllDay` contract (standard Series/Sets/Plays/Editions/Badges/Parallels, no media/IPFS resolver); Pinnacle acct `0xedf9df96c92f4595` → `PackNFT` + `Pinnacle` (standard renderID + MetadataViews, no resolver). Both `?expand=contracts` responses truncate inside the first contract's base64 source (persistent limitation — a resolver named e.g. `AllDay…`/`Pinnacle…` would sort into the truncated tail), but there's **no public announcement** of an AllDay/Pinnacle resolver, consistent with the TS-only IPFS scope. HIGH-value find still absent.
- (b) **WNBA pin progress = the §1 actionable item.** `resolver_misses` 28→14 (see above).
- (c) **Reference-app** `https://dapperlabs.github.io/dapperlabs-ipfs-reference-app/` — **fetched OK** (live, not empty), titled **"NBA Top Shot IPFS Reference"** ("Browse NBA Top Shot plays with IPFS asset information"), **TS-only**. web_fetch renders it as content (HTML/build-chunk hash not extractable that way), so the diff signature is just "present + TS-only" — no AllDay/Pinnacle reference app. Not a new signal.

**3. On-chain data-anomaly sweep (last 14–21d, read-only)**
- **Venue-detection — CLEAN, no new venue.** TS `onchain` sales (26,404/14d) with non-null payer collapse to a **single** proposer/payer pair: proposer `0xead892083b3e2c6c` / payer `0x18eb4ee6b3c026d2` = **23,442** (the known dapper.market / nbatopshot.com custodial rail). **Zero TS proposer accounts had their first-ever sale in the last 7 days** (new-proposer query returned `[]`) → no new or rapidly-growing custodial signer → **no new execution venue**.
- **New source tag `onchain_dapper_v2`** appears for AllDay (735, from ~06-14) and Golazos (42, from ~06-12). This is **RPC's own indexer taxonomy** now distinguishing the **Dapper V2 storefront** leg (`0x4eb8a10cb9f87357.NFTStorefrontV2`) from V1 (`onchain_dapper_v1`, 3,886) — Dapper's own already-scanned infra, **not an external venue**. Note for next run so it isn't mistaken for a new surface.
- Mix otherwise normal: TS `offer_fill` 7,167 (OffersV2, internal), `topshot_gql` 2,811 (internal RPC ingest, buyer-blind by design), `source=null` 683 (flow-backfill, stopped 06-13, healthy). Pinnacle secondary spike ~06-19 (§1) captured by `pinnacle_sales`.

**4. Flowscan glance:** skipped (slow/client-rendered; web + DB sufficient).

**Baselines carried to next run:** WNBA `resolver_misses` = **14** (was 28; watch for further drops = more pinning) · TS custodial pair `0xead…`/`0x18eb…` ≈ only non-null-payer rail, **0 new proposers/7d** · `onchain_dapper_v2` = Dapper V2 storefront leg (internal tag, AllDay/Golazos) · Pinnacle secondary ~400–800/day post-Legendary-drop (was ~50–160) · no AllDay/Pinnacle IPFS resolver · reference-app = TS-only · dapper.market presumed still 3 collections / no analytics tab (not live-crawled). **Open methodology note:** REST `?expand=contracts` truncates on source bloat — full contract-name enumeration of the AllDay/Pinnacle accounts (to rule out a tail resolver) needs a names-only endpoint or live Flowscan, not the current fetch.

Sources: TS IPFS PR — globenewswire.com/news-release/2026/06/12/3311071/0/en/Every-Moment-Video-Is-Now-Independently-Verifiable-on-NBA-Top-Shot-Built-by-Dapper-Labs-on-Flow-Network.html ; TS class-action settlement — betakit.com/dapper-labs-reaches-tentative-settlement-in-nba-top-shot-class-action-suit/ ; NFL next-gen — bitcoinworld.co.in/dapper-labs-pauses-nfl-all-day-nft-minting/ , decrypt.co/367926/nfl-all-day-stops-issuing-nfts-dapper-labs-future-plans-league ; Pinnacle Legendary drop — cointrust.com/market-news/dapper-labs-unveils-disney-pinnacle-a-digital-evolution-of-pin-collecting , globenewswire.com/news-release/2026/02/07/3234119/0/en/Dapper-Labs-Ecosystem-Disney-Pinnacle-NFL-ALL-DAY-and-NBA-Top-Shot-Drive-Consumer-Engagement-on-Flow.html

---

## 2026-06-17 — first run (baseline). No new material ecosystem developments.

Verdict: nothing clears the escalation bar. No Trevor notification. Baselines established below for diffing next week.

**1. Ecosystem / web sweep**
- NBA Top Shot **"Every Moment Video Is Now Independently Verifiable"** (announced ~2026-06-12) = the formal public PR of the IPFS move RPC already integrated (TopShotIPFSResolver + daily art cron + verified-media badges). **Explicitly NBA Top Shot only** — no AllDay/Pinnacle IPFS extension announced. Already known; not new.
- **NFL All Day primary minting paused 2026-05-14**; Dapper (Roham) framed it as building a "next evolution / next-generation" NFL collectibles product, details TBD. Already reflected in RPC (AllDay primary sales are historical-only). **Carry as watch item:** if that next-gen NFL product ships, it may be a new contract/collection to index.
- **Messari State of Flow Q1 2026:** NBA Top Shot volume +12.2% QoQ, new-contract deployments +25.2%, Flow on pace to cross 1B lifetime txns in Q2. Healthy ecosystem; no threat/new venue.
- **No new Flow marketplace or aggregator surfaced.** Flowty remains dead for RPC's collections; Flowverse NFT (multi-buy) is pre-existing. **No dapper.market feature change found** — no unified cross-league search live yet, no Pinnacle/UFC added (still 3 collections: TS/AllDay/Golazos), no analytics/FMV tab. RPC's differentiators (FMV confidence, squeeze, pack EV, cross-collection, badges/rookies/trophies, concierge) remain intact.

**2. IPFS expansion tripwires**
- (a) **New IPFS-resolver contracts:** AllDay account `0xe4cf4bdc1751c65d` REST enumeration is *partial* — `?expand=contracts` returns full base64 source and the response truncates; `AllDay` contract confirmed present, no IPFS resolver visible in the returned portion. Pinnacle account `0xedf9df96c92f4595` was **not fetched** — `web_fetch` provenance rejected the URL because the task prompt abbreviates it (".../accounts/edf9df96c92f4595"). **Methodology fix for next run: write the full Pinnacle REST URL verbatim in the task prompt** (`https://rest-mainnet.onflow.org/v1/accounts/edf9df96c92f4595?expand=contracts`) so web_fetch accepts it. No public signal of an AllDay/Pinnacle IPFS resolver (the 06-12 announcement is TS-only), so the HIGH-value find is absent this week.
- (b) **WNBA pin progress:** `topshot-onchain-art-backfill` `resolver_misses` = **28**, flat across 06-12 → 06-17 (baseline was 27 on 06-10). No WNBA pinning event. Daily art cron green (`ok=true`) every day through 2026-06-17 09:49Z. If `resolver_misses` later drops, Dapper pinned WNBA — run `scripts/refresh-ipfs-catalog.mjs` (IPFS_LOADER_TOKEN from the ipfs-catalog-loader edge fn) so the catalog/badges/pin-exports pick it up.
- (c) **Reference-app dataset HEAD:** not checked — URL not in the prompt verbatim → web_fetch provenance. Deferred; add the full URL to the task prompt to enable.

**3. On-chain data-anomaly sweep (last 14–21d, read-only)**
- **Execution-account capture is LIVE and healthy** (handoff Items 1–2 shipped). Of 29,787 TS `onchain` sales in 14d, 28,960 (~97%) carry buyer+payer+proposer; capture running since ~2026-05-27. AllDay V1 (`onchain_dapper_v1`) carries buyer only, no payer/proposer (by design).
- **Venue-detection profile — CLEAN, no new venue.** TS sale flow is dominated by the two known Dapper custodial accounts: proposer `0xead892083b3e2c6c` (DUC treasury) = 47,481 sales, payer `0x18eb4ee6b3c026d2` (Dapper ops) = 49,202 sales (21d) — i.e. the dapper.market / nbatopshot.com custodial rail. The proposer tail is small individual self-custody buyers (≤92 each, present since capture start). One single-day blip: `0x31e6b70630aeb7d6` proposed 38 TS buys on 06-12 only — an individual spree, not a venue (a new marketplace shows up as a *sustained, growing* custodial signer like 0xead…/0x18eb…). **No new or rapidly-growing custodial signer account → no new execution venue this week.**
- Marketplace/source mix normal. Note: a `topshot_gql` source tag appears for 1,285 TS sales since 06-13 (buyer/exec-account-blind by design) — an internal RPC ingest path, not an external venue.

**4. Flowscan glance:** skipped (slow/client-rendered; web + DB sufficient this run).

**Baselines carried to next run:** WNBA `resolver_misses` = 28 · TS custodial proposer `0xead892083b3e2c6c` / payer `0x18eb4ee6b3c026d2` (≈98%+ of TS flow) · no AllDay/Pinnacle IPFS resolver observed · dapper.market = 3 collections, no analytics tab, no unified search. **Open methodology fixes:** full Pinnacle REST URL + reference-app URL must be written verbatim in the task prompt for those two tripwires to run.

Sources: NBA Top Shot IPFS PR — finance.yahoo.com/markets/crypto/articles/every-moment-video-now-independently-130000916.html ; pr.nba.com/tag/dapper-labs/ ; Messari State of Flow Q1 2026 — messari.io/report/state-of-flow-q1-2026 ; NFL pause / Flow updates — coinmarketcap.com/cmc-ai/flow/latest-updates/
