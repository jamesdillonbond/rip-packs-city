# Flow Ecosystem Watch — running log

Weekly READ-ONLY external-intelligence sweep for RPC. Beat = the OUTSIDE world (new marketplaces, contracts, standards, execution venues, IPFS expansion) for the Flow collections RPC tracks — complements `rpc-daytime-monitor` / weekly-health, which watch RPC's own pipelines. Design + rationale: `docs/strategy/flow-onchain-intelligence-2026-06-09.md`; dapper.market recon: `docs/research/dapper-market-recon-2026-06-08.md`.

Each entry records what was checked + found so the next run has a baseline and doesn't re-report known items. Newest first.

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
