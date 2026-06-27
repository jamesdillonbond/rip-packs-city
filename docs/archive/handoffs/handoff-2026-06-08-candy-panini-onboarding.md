# Handoff 2026-06-08 — Candy (Solana) + Panini onboarding as supported collections

## Context

Cowork already shipped the DB layer live. This handoff covers the code layer (registry, worker, ingest routes) that Cowork cannot push because it has no git creds. Current HEAD when this was written: bacd652 ("feat(verify): HybridCustody read-only wallet verification").

Shipped live by Cowork (migration audit_20260608_seed_candy_panini_collections):
- collections row "candy_mlb" — id 209ade70-32c5-4470-bc7c-4793d660f713, chain=solana, is_active=false, contract_address NULL.
- collections row "panini_blockchain" — id d1a0a7f5-609a-49f4-a1a7-4eaac55b020b, chain=ethereum, is_active=false, contract_address NULL.
- Both verified inert: is_active=false means any WHERE is_active=true sweep skips them; the collection_chains view resolves both correctly. Revert for the whole seed: DELETE FROM public.collections WHERE slug IN ('candy_mlb','panini_blockchain');

Full research + rationale: docs/research/candy-panini-integration-research-2026-06-08.md. The chain_type enum already carries solana + ethereum (no ALTER TYPE needed). Chain-abstraction Phases A–F are complete, so chain is reached via collection_id FK everywhere — no schema rework, just new ingest.

Reality check on what is buildable today vs blocked: Candy's secondary market opens only after its Solana migration completes (targeted ~June 8) so the on-chain anchors (collection address, Magic Eden symbol) are NOT yet publicly discoverable. Items 1 and 2 below are unblocked and should be done now. Items 3–7 are scaffold-now, wire-after-discovery (Item 0). Panini (Item 8) is intentionally low-priority / thin.

Note on the nightly autonomous pass: chain-two work is on its off-limits list, so it will not touch any of this. No docs/FREEZE.md needed. This is net-new code (no existing Candy/Panini routes), so it will not collide with anything committed in the last 24–48h.

---

## Item 0 — DISCOVERY (blocking for Items 3–6; partly gated on Candy trading going live)

None of these are in any public source yet; capture them from live data once Candy secondary trading opens (or once you have any one Candy fan wallet address). Do this read-only first; do not guess/hardcode.

What to capture:
- Candy's Metaplex Core COLLECTION address(es) per IP line (MLB first; DC/others later).
- Candy's UPDATE AUTHORITY pubkey (to verify authenticity and to disambiguate from the unrelated NxGen "$CAND" Raydium token — never index that token).
- Magic Eden collection SYMBOL(s) for the activities/listings/stats endpoints.
- The exact attribute keys that hold SERIAL number and EDITION SIZE, plus the right stable edition key to use for editions.external_id (inspect one live asset; do not assume).

How to capture (any one works):
- If you have a holder wallet W: call DAS getAssetsByOwner for W through helius-proxy (Item 2), then read each asset's grouping[].group_value (= collection address) and plugins/content.metadata.attributes (= serial/edition).
- Magic Eden: open the Candy collection page, read the collection details for the symbol + on-chain collection address; or hit the public ME API once the symbol is guessed/known.
- Solscan: search the collection/update-authority once known and confirm interface=MplCore.

Until Item 0 yields a real collection address, leave collections.contract_address NULL for candy_mlb and keep is_active=false.

---

## Item 1 — Correct + wire the registry placeholders in lib/collections.ts (DO NOW, unblocked)

File: lib/collections.ts (verified present; I read it this session). Two existing entries are stale/placeholder.

1a. candy-mlb entry (currently WRONG): it says chain:"candy", dbChain:null, partner:"Futureverse", pitch:"Reserved for Candy MLB integration on the Root Network." Candy left Futureverse/The Root Network; under new owner Tad Smith it migrated to Solana / Metaplex Core. Change to:
- dbChain: "solana"
- partner: "Candy Digital"
- supabaseCollectionId: "209ade70-32c5-4470-bc7c-4793d660f713"
- pitch: rewrite to Solana (e.g. "Wallet analytics, FMV, and pack/edition intelligence for Candy MLB on Solana — Metaplex Core, secondary on Magic Eden.")
- Keep published:false until Items 3–6 produce real data. Leave the partner/roadmap chain label field ("chain") as you prefer; dbChain is the authoritative one for dispatch.

1b. panini-blockchain entry: set dbChain:"ethereum" (the public-indexable surface is the OpenSea Ethereum bridge; the core platform is a private Hyperledger Sawtooth chain that is not a chain_type value and is not directly indexable). Add supabaseCollectionId:"d1a0a7f5-609a-49f4-a1a7-4eaac55b020b". Keep published:false. Optional one-line comment: bridge currently carries only Toikido "Bad Eggs" (non-sports); sports cards not yet bridged.

1c. Add both to the DB-slug + UUID maps lower in the same file (these maps are currently keyed only to the 5 Flow collections):
- SLUG_TO_DB_SLUG: add "candy-mlb":"candy_mlb" and "panini-blockchain":"panini_blockchain".
- COLLECTION_UUID_BY_SLUG: add "candy-mlb":"209ade70-32c5-4470-bc7c-4793d660f713" and "panini-blockchain":"d1a0a7f5-609a-49f4-a1a7-4eaac55b020b".
- (DB_SLUG_TO_SLUG is derived automatically from SLUG_TO_DB_SLUG — no manual edit.)

Why: the maps are the frontend-slug <-> DB-slug <-> UUID bridge; routes/components drift without them. Adding now (while published:false) is safe and lets later items resolve the collection by slug/UUID.

Verified counts: the registry has 8 entries (5 published Flow + candy-mlb + panini-blockchain + rwa); the two maps currently hold 5 keys each (the published Flow set). The DB collections table has exactly 5 rows pre-seed, now 7 after the Cowork seed.

Revert: git revert the commit (additive maps + field edits; nothing reads candy/panini yet so revert is a no-op for downstream).
Verify: npx tsc --noEmit clean; deploy READY; existing collection pages unchanged (these stay published:false so nothing renders publicly yet).

---

## Item 2 — Create the helius-proxy Cloudflare Worker (DO NOW; NEW auth surface)

New dir: workers/helius-proxy/ — mirror workers/topshot-proxy/ (structure is just README.md + index.js + wrangler.toml; confirmed by inspecting topshot-proxy and base-proxy).

What it does: server-side proxy to a DAS-enabled Solana RPC (Helius recommended) so the Helius API key never ships to the client, consistent with RPC's proxy-everything rule (Vercel/Supabase egress also keeps the key off the edge). It forwards JSON-RPC POST bodies (getAssetsByGroup, getAssetsByOwner, getAsset) to the Helius endpoint.

Auth surface (IMPORTANT, per CLAUDE.md "Worker auth surfaces"): give helius-proxy its OWN secret — do NOT reuse TS_PROXY_SECRET or INGEST_SECRET_TOKEN. Suggested: HELIUS_PROXY_SECRET via X-Proxy-Secret header (mirror base-proxy's PROXY_SECRET gate, but a distinct secret name/value). The upstream Helius key is a second worker secret (e.g. HELIUS_RPC_URL containing the keyed endpoint, or HELIUS_API_KEY).

wrangler.toml: name="helius-proxy", main="index.js", compatibility_date, workers_dev=true; secrets set via wrangler secret put HELIUS_PROXY_SECRET and wrangler secret put HELIUS_RPC_URL (note: workers deploy via manual wrangler, not git push — see memory worker-deploy-drift).

Trevor provides: a Helius (or Triton/QuickNode) DAS-enabled RPC URL + key. Free Helius tier is fine to start.

Revert: delete the worker (wrangler delete) + remove the dir. Nothing else depends on it until Item 3.
Verify: a getAssetsByGroup round-trip through the worker returns assets for a known Solana collection (test with any public Metaplex Core collection until Candy's is known).

---

## Item 3 — Candy editions ingest via DAS (scaffold now, wire after Item 0)

New: lib/chains/solana/ (mirror lib/chains/flow/ — that dir holds flow.ts, topshot.ts, cadence/, wallet-backfill-helpers.ts, etc.). Put Solana primitives here: a DAS client (calls through helius-proxy), a normalizeCandyAsset() that maps a Metaplex Core asset -> RPC editions/wmc shape.
New route (Vercel) or Supabase edge fn: e.g. app/api/ingest/candy/route.ts (or a cron route under app/api/cron/). Either is fine; a Vercel route matches the existing ingest pattern and can be deployed from Cowork later if you prefer.

Logic: getAssetsByGroup(groupKey="collection", groupValue=<CANDY_COLLECTION_ADDR from Item 0>, page,limit=1000) -> for each asset:
- editions row (one per edition/card design): external_id = the stable Candy edition key (from metadata; confirm in Item 0), collection_id = 209ade70-...; circulation_count = edition size; thumbnail_url/video_url = the Arweave URIs (directly fetchable — no signed-URL problem like Pinnacle); player_name/set_name/tier from metadata attributes.
- each Core asset = one serial -> wmc/moments row: serial_number from the attribute, owner = Solana base58 pubkey, edition_key = editions.external_id (keep the wmc.edition_key == editions.external_id invariant — see memory wmc-edition-key-contract).

Reuse, don't reinvent: editions/sales/wmc/fmv_snapshots are chain-agnostic (keyed by collection_id). Only decide AFTER inspecting a live asset whether Candy's attribute model fits editions cleanly or needs a parallel candy_editions table the way Pinnacle has pinnacle_editions (default: try to fit editions first).

Cron: add via cron-job.org with its own stagger slot off the :00 rush (see skill rpc-cron-ops); add the pipeline to pipeline_cadence_watchlist ONLY after the first successful run (watchlisting a pipeline that has never run creates a false stall alert).

Revert: git revert; the route is additive and only writes rows for collection_id 209ade70 (delete those rows to fully undo).
Verify: npx tsc --noEmit clean; one manual run writes >0 editions for candy_mlb; spot-check a serial's thumbnail resolves.

---

## Item 4 — Candy sales ingest via Magic Eden (after Item 0; needs trading live)

New route: app/api/candy-sales-indexer/route.ts (mirror the AllDay/EVM indexers).
Source: Magic Eden Solana API, base https://api-mainnet.magiceden.dev/v2/. Endpoints once the symbol is known: GET /collections/{symbol}/activities (secondary sales/listings/bids -> sales rows), /collections/{symbol}/listings (live asks -> cached_listings_v2), /collections/{symbol}/stats (floor/volume). Free tier ~120 QPM / 2 QPS; set MAGIC_EDEN_API_KEY for higher limits.
Write sales rows: marketplace='magic_eden', source='solana_das', signature is 88-char base58 (dedup on it; the sales column is already text and year-partitioned — fits per the chain-abstraction inventory), collection_id=209ade70-..., price in USD (convert SOL->USD at sale time). Add Tensor as a second source if Candy trades spread beyond Magic Eden, or parse Helius enhanced-transaction sale events for marketplace-agnostic coverage.
Backfill from the trading-open date so 30 days of FMV history accrues.

Revert: git revert; delete sales rows for collection_id 209ade70.
Verify: tsc clean; one run writes >0 sales; dedup holds on a re-run (no duplicate signatures).

---

## Item 5 — Candy wallet/portfolio backfill (after Item 2)

DAS getAssetsByOwner(ownerPubkey) through helius-proxy -> upsert into wmc for that wallet (Solana base58 address). Mirror lib/chains/flow/wallet-backfill-helpers.ts but in lib/chains/solana/. Concierge/profile/share become chain-aware automatically via collection_id once editions+wmc exist.
Revert: git revert. Verify: backfilling a known Candy wallet populates wmc rows for collection_id 209ade70.

---

## Item 6 — FMV (config, after Items 3–4 produce data)

Point the existing engine at the new collection_id — no pricing-logic rewrite (fmv-recalc is chain-implicit via collection_id; file app/api/fmv-recalc/route.ts is the engine). Let it compute sales-based WAP + confidence for candy_mlb. Expect LOW/sparse confidence at first on a thin, fresh order book — that is correct, not a bug. Do NOT auto-promote zero-sale editions to ASK_ONLY (see memory ts-nodata-troll-asks).
Revert: stop including the collection_id. Verify: fmv_snapshots rows appear for candy_mlb after a recalc.

---

## Item 7 — Publish Candy (LAST, after data flows + spot-checks pass)

Flip live: UPDATE public.collections SET is_active=true WHERE slug='candy_mlb'; and set published:true on the candy-mlb registry entry; wire its pages array (overview/collection/market/sniper as data supports), brand accent, OG card, sitemap entry. Run the rpc-insights-qa checklist before any public surface. Add additional Candy IP lines (DC Comics etc.) as ADDITIONAL collections rows + registry entries on the same pattern (per-IP rows are recommended in the research doc).
Revert: set is_active=false + published:false.

---

## Item 8 — Panini (LOW PRIORITY / thin; keep published:false)

Honest state: the valuable sports-card secondary market lives on Panini's private Sawtooth chain (not indexable); NBA/NFL licenses expired to Fanatics; the only public surfaces are (a) the OpenSea Ethereum bridge, currently carrying just Toikido "Bad Eggs" (non-sports), and (b) CryptoSlam's aggregate API (secondary totals, derivative). Do the minimum now (registry wiring in Item 1b is enough) and build ingest only if a trigger fires (a public-chain remint, sports cards getting bridged, or a deliberate FIFA-Collect/soccer push).
If/when building: clone the existing EVM plane — app/api/cron/evm-transfers-ingest/route.ts + schema supabase/migrations/20260513120000_evm_nft_indexer_schema.sql + workers/base-proxy/ — to index the bridged Ethereum contracts (read via the base-proxy/Alchemy/Reservoir path already in the repo). collection_id = d1a0a7f5-.... Keep is_active=false / published:false until there is real sports content to show.

---

## Env vars to add (Vercel + worker)

- HELIUS_PROXY_SECRET (new; worker secret + Vercel var) — its own rotation domain, never shared with TS_PROXY_SECRET/INGEST_SECRET_TOKEN.
- HELIUS_RPC_URL or HELIUS_API_KEY (worker secret) — the DAS-enabled endpoint.
- MAGIC_EDEN_API_KEY (optional; Vercel var) — only needed for higher ME rate limits.
Env var writes are POST https://api.vercel.com/v10/projects/{projectId}/env?teamId={teamId} via PowerShell Invoke-WebRequest (projectId prj_YBJ6Utl32GfyBOIzbsp3kbshJh96, teamId team_YWGCVToPBJSS60NgVh8jiCFV).

---

## Guardrails (repeat every handoff)

- Commit and push DIRECTLY to main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first.
- On Windows, commit via PowerShell git (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest. Redeploy = POST https://api.vercel.com/v13/deployments with gitSource ref main (repoId 1188272071).
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly. Ingest routes that do long DAS walks should use fire-and-forget (import { after } from 'next/server'; return 202) like the existing indexers.
- CRLF: do not string-replace-patch on Windows; use full-file writes (per CLAUDE.md). Watch for the mount NUL-corruption class — run scripts/check-tree-corruption.mjs if git acts strange.
- Workers deploy via manual wrangler, not git push (memory worker-deploy-drift).

## Let Claude Code correct false premises

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. In particular: confirm the exact lib/collections.ts field names by reading the file (the Collection interface uses id/label/dbChain/supabaseCollectionId/published as of this session), and confirm the Magic Eden / DAS response shapes against a live call before hardcoding parsers.

## Expected end state

After Items 1–2: commit on main, deploy READY, npx tsc --noEmit clean, helius-proxy reachable — Candy/Panini registry wired to the seeded UUIDs, still unpublished (nothing user-facing changes). After Items 3–7 (post-discovery, ~mid-June+ once Candy trading is live): candy_mlb has editions + sales + FMV flowing, is_active=true, published — Candy live as RPC's first non-Flow (chain-two / Solana) collection. Panini stays scaffolded-but-dark pending a trigger.
