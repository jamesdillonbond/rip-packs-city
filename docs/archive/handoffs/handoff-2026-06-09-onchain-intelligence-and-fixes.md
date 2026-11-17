# Handoff — on-chain intelligence + 6 fixes — 2026-06-09

Companion to `docs/strategy/flow-onchain-intelligence-2026-06-09.md`. All items below were diagnosed 2026-06-09 (several via parallel research agents); line numbers are grep/read-verified but may drift — anchor on symbol names. Each item is an independent commit with its own revert. Nothing here was shipped from Cowork (route/.tsx/indexer code). No DB migration was applied autonomously.

**Guardrails (every item):** commit and push directly to `main`, no branches/PRs. On Windows commit via PowerShell `git` (Git Bash can silently no-op); verify with `git rev-list --count origin/main..HEAD` (expect 0). Full-file writes or findIndex-on-split-lines, not string-replace patches (CRLF). All Top Shot GQL MUST route through the topshot-proxy worker (`TS_PROXY_URL` + `x-proxy-secret: TS_PROXY_SECRET`) — never the raw `public-api.nbatopshot.com` host (Cloudflare blocks Vercel egress). Your direct file inspection wins over this doc on any disagreement.

**Build order:** Items 1+2 together (one decode pass, foundational), then 3 and 5, then 4 (Trevor-gated), 6 optional.

---

## Item 1 — resolve the Top Shot buyer (HIGH — flagship is 100% buyer-blind)

**Problem (confirmed):** `app/api/sales-indexer/route.ts` indexes `A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased` (line 26). That event carries `id`, `price`, `seller` only (event type lines ~196-199; mapped ~264-267). At the sale insert (~line 536-541) it writes `buyer_address: null` (line 538) and `seller_address: evt.data.seller`. Result: **0% of Top Shot sales have a buyer** (verified: 56,488 onchain TS sales in 30d, all null; All Day is 96% resolved, Flowty 100% — only TS is blind). This kills top-buyers, accumulation, and cohort analytics for the flagship collection.

**The buyer is in the same transaction.** Every `MomentPurchased` tx also emits `A.0b2a3299cc857e29.TopShot.Deposit` (and `A.1d7e57aa55817448.NonFungibleToken.Deposited`) with the matching moment `id` and a `to` field = the real buyer. For Trevor's verified buy, `Deposit.to = 0xbd94cade097e50ac`. This is the **same decode RPC already does for All Day V1** in `lib/dapper-v1-tx-decode.ts` (it reads `<collection>.Deposit (.to)` → buyer). Apply that pattern to the Top Shot path.

**Forward fix (`app/api/sales-indexer/route.ts`):** after parsing each `MomentPurchased`, resolve the buyer from the same tx's `TopShot.Deposit` event whose `id` matches the purchased moment, and set `buyer_address` to that `to` (normalized, lower-case 0x16hex). Two implementation options depending on how the indexer fetches:
- If it already pulls full block/tx event sets, find the sibling `Deposit` event in the same `transactionId` with matching moment id — no extra network call.
- If it only fetches `MomentPurchased` events, add a per-tx fetch of `/v1/transaction_results/{txId}` (the helper in `lib/dapper-v1-tx-decode.ts` already does this) and read `Deposit.to`. Budget it per tick like the V1 decoder (e.g. 25 lookups/tick) so the route stays under its timeout; rows that exceed budget keep `buyer_address: null` and get picked up next tick.
- Guard: ignore intermediary/escrow `to` values if any appear (for native `TopShotMarketV3` the `Deposit.to` is the real buyer directly — confirmed). For the legacy V1 `Market` path use the same `Deposit.to`.

**Backfill (new route `app/api/admin/backfill-topshot-buyers/route.ts`, Bearer `INGEST_SECRET_TOKEN`):** select TS sales where `buyer_address IS NULL AND transaction_hash IS NOT NULL`, oldest-or-newest-first, in batches (e.g. 200/run); for each, fetch `/v1/transaction_results/{txHash}`, decode `Deposit.to`, `UPDATE sales_<year> SET buyer_address = …`. ~70k/mo + history is large — make it idempotent, resumable (cursor in `pipeline_runs.extra`), and fire-and-forget (`after()`, return 202). Wire a temporary cron until the backlog drains, then disable. Mirror `/api/admin/recover-v1-budget-exhausted`.

**Verify:** new TS sales land with a non-null `buyer_address` (spot-check Trevor's wallet's recent buys resolve to `0xbd94cade097e50ac`); the 30d null-buyer rate for `marketplace='topshot'` falls from 100% toward All Day's ~4%. **Revert:** `git revert` (forward fix); the backfill only populated a column — no revert needed, or `UPDATE … SET buyer_address=NULL WHERE …` if desired.

---

## Item 2 — capture the execution accounts (HIGH — powers venue detection)

**Why:** dapper.market was invisible because RPC keeps the sale event but discards the transaction envelope. The proposer/payer accounts are how you tell execution venues apart and detect new ones (strategy doc §2-3). dapper.market signs with proposer/authorizer `0xead892083b3e2c6c` and payer `0x18eb4ee6b3c026d2`.

**DB migration (shippable):** add `payer_address text`, `proposer_address text` to `sales` (nullable; partitioned table — add to the parent). Optionally `execution_venue text` (derived label, nullable) for later classification.

**Forward capture (`app/api/sales-indexer/route.ts`, same decode pass as Item 1):** when fetching tx data, also fetch `/v1/transactions/{txId}` and read `payer` and `proposal_key.address` (proposer) and `authorizers[]`. Store `payer_address`/`proposer_address` on the sale. (The buyer decode uses `/v1/transaction_results/{id}` for events; the signer accounts come from `/v1/transactions/{id}` — one extra GET, or batch both.) Same per-tick budget as Item 1.

**Monitor (DB migration, after data exists — Layer B):** a read-only view/RPC, e.g. `v_sale_execution_accounts_7d`, returning per-`payer_address` (and per-`proposer_address`) sale count + volume over 7/30d for `marketplace='topshot'`, plus a `first_seen_at`. A new or fast-growing payer = a new venue. Surface it on the ops dashboard and/or add a `pipeline_runs`-logged check that flags when an unseen execution account crosses a volume threshold. This is the "never get surprised" signal in-product.

**Verify:** new TS sales carry payer/proposer; `0x18eb4ee6b3c026d2`/`0xead892083b3e2c6c` appear as a dominant cluster; the view lists them. **Revert:** drop the columns/view; `git revert` the route change.

---

## Item 3 — usernames instead of wallet addresses (MED-HIGH — ~70% already built)

**State:** RPC already has the cache table `wallet_usernames(wallet_addr, username, source, resolved_at, updated_at)`, the resolver RPC `analytics_resolve_usernames(text[])→jsonb` (reads only `wallet_usernames`), the route `GET /api/analytics/wallets/resolve-usernames`, the client hook `useResolveUsernames` + `displayName()` (`lib/analytics/username-resolver.ts`), and the address→username GQL in `scripts/seed-wallet-usernames.ts` (TS `searchUsers(input:{searchPhrase: addr})` → `publicInfo{username,flowAddress}`). The gap is **population** (57 rows ≈ 1% of the 2,698 distinct sale counterparties in 90d) and **wiring** (~8 surfaces still render raw `0x…`).

**(a) DB migration (shippable):** (i) broaden `analytics_resolve_usernames` to resolve each address by priority `wallet_usernames` → `seeded_wallets.username` (keyed `wallet_address`) → `saved_wallets.username` (keyed `wallet_addr`), so the existing ~107 seeded/saved names show immediately. Preserve the `(text[])` signature + STABLE SECURITY DEFINER + grants (currently NOT granted to anon — keep that; the public route calls it via the service client). (ii) add `wallet_usernames.last_attempted_at timestamptz` (negative-cache so missing-username addrs aren't re-fetched forever). (iii) add an RPC `wallet_usernames_unresolved(p_limit int)→text[]` returning distinct recent on-chain addresses (sale buyer/seller last N days + moment owners) absent from `wallet_usernames` and not recently attempted.

**(b) Populator (new route `app/api/cron/resolve-wallet-usernames/route.ts`, Bearer `INGEST_SECRET_TOKEN`):** pull a batch via `wallet_usernames_unresolved(200)`, call TS `searchUsers(searchPhrase: addr)` **through the topshot-proxy** (`TS_PROXY_URL`/`x-proxy-secret` — the `lib/verify-wallet-gql.ts` pattern, NOT the raw host used by the seed script), upsert hits via the existing `cache_topshot_username(username, wallet_address, source)`, stamp `last_attempted_at` on misses, throttle ~5 RPS, log `pipeline_runs` (`pipeline='wallet-username-resolver'`), fire-and-forget under the 30s cap. Schedule every ~20-60 min staggered off `:00`. Dapper SSO = one username per wallet across all 4 Flow collections, so one TS resolution is authoritative.

**(c) UI (handoff — route/.tsx):** a shared `components/UserLabel.tsx` — client variant wraps `useResolveUsernames([address])`+`displayName()` (renders `@username` with `title={address}`, else mono-font truncated `0x…`, optional `/profile/<addr>` link); server variant for `app/moment/[id]/page.tsx` + the wallets directory (resolve via `analytics_resolve_usernames`; fix `lib/flowty-username.ts` to read the cache table). Swap these raw-address surfaces to `<UserLabel>` (collect a table's addresses into one `useResolveUsernames` call at the parent, pass the map down): `app/moment/[id]/page.tsx` (OwnerLink ~1448, buyer/seller ~1070-1071), `components/entity/SalesTablePaginated.tsx` (+ `_shared.tsx` WalletCell), `components/analytics/BiggestSales.tsx`, `components/WhaleWatch7d.tsx`, `components/analytics/NetMarketplaceLeaderboard.tsx`, `PulseDashboard.tsx`, `ListingsDashboard.tsx`, `app/(analytics)/analytics/wallets/page.tsx`, `components/MomentDetailModal.tsx:418`. Keep all existing `/profile/<addr>` link targets (the public profile route resolves by address too). Precedence if RPC's own `profile_bio.username` exists for an address, prefer it (links to their RPC profile), else the TS username. **This compounds with Item 1** — the buyer side of TS sales history only becomes username-able once buyers are resolved.

**Verify:** sales history / leaderboards show `@handles` with address fallback + tooltip; `wallet_usernames` row count climbs each populator run. **Revert:** `git revert` per commit; restore the prior `analytics_resolve_usernames` body; drop the added column/RPC.

---

## Item 4 — Pack EV accuracy (REVIEW-GATED — pricing logic, get Trevor's sign-off)

**Bug (confirmed, with worked examples):** TS pack EV suffers **depletion survivorship bias.** `drop_weight = remaining/totalUnopened` (edge fn `compute-topshot-pack-ev` v21, `supabase/functions/compute-topshot-pack-ev/index.ts` ~line 1212). As a pack sells through, cheap commons hit `remaining=0` (excluded), leaving the expensive chases; the renormalized per-slot EV (`Σ(w·fmv)/Σ(w)` over surviving priced editions, in DB RPC `compute_pack_ev_per_edition_weighted`) then treats the survivors as the whole pack. The arithmetic reconciles to the cent — the *model* is wrong.

Examples (reported = public board / dist page; both from `pack_ev_latest.gross_ev`):
- dist **5888** "Birthday Party Pack", $4 → **$370 EV / 92.5x**, 15 of 80 editions left (86% depleted), one a $1,080 troll-ask Ultimate.
- dist **5020** "Chance Hit", $15 → **$829 / 55x**, **2 of 80** left (99% depleted).
- Healthy full pools reconcile fine (dist 474: $881 on $774 = 1.14x, 79/80 pullable). Of 60 TS packs >3x, **54 (90%)** are survivor artifacts. 98.7% of TS packs are ≥80% depleted.

The "confidence" flag misses it: `topshot_pack_reality_top_ev.high_variance = (fmv_coverage_pct < 80)`, but dist 5888 has **100% coverage**, so the 92.5x is presented as confident and ranks #1.

**Fixes (Trevor picks the EV definition before shipping):**
- **4a (fast, view-only DB migration):** in `topshot_pack_reality_top_ev` and the dist-page KPI, exclude/neutralize collapsed-pool packs — predicate `Σ(drop_weight) >= 0.5×slots` (or `depletion_pct < 60`, or `n_pullable/original_edition_count >= 0.5`). Removes the embarrassing numbers from the headline. Reversible (`CREATE OR REPLACE` the view).
- **4b (real fix, edge-fn + DB-RPC):** compute EV on the **original** drop distribution, not the depleted remaining one (the edge fn already captures `originalCountsByTier`; needs the original *per-edition* pool persisted). EV stops drifting as packs open. Bigger lift.
- **4c (DB migration):** re-key `high_variance` to also trip on `depletion_pct >= 60 OR n_pullable < 10 OR Σdrop_weight < 0.5×slots`.
- **4d (DB migration):** surface `weighted_fmv_coverage_pct` (already computed in the RPC, discarded) instead of the unweighted coverage that pessimistically counts dead editions.
- **4e (operator):** throughput — 448 TS packs are >48h stale (BATCH_SIZE=4 ≈192/day < 800 targets); lever is cron frequency, not batch.

**DEFINITION — Trevor's direction (2026-06-09), authoritative:** anchor pack EV to the **current secondary low-ask**. Two numbers, only one is broken: the *price* is already the secondary low-ask (`pack_ev_latest.pack_price` with `price_source='secondary'` / `secondary_ask` — e.g. dist 5888 = $4) and stays as-is; the broken number is the *pull value* (the $370). The key principle: **a pack freely listed on secondary for $4 cannot actually contain $370 — the secondary ask IS the market's honest EV estimate, and the model must reconcile with it.** Evidence: 76 TS packs show EV >2× their own live secondary ask at **96% avg depletion**, while the 8 genuinely fresh packs (<40% opened) average a **0.51×** ratio (ripping fresh = mildly -EV, correct). So:
- **The pull-value EV must be computed on the ORIGINAL distribution (4b) — this is THE fix, not optional.** Then a fresh pack's EV comes out ≈ its secondary ask for efficient packs, and the *only* meaningful EV-vs-ask divergence left is a real deal (a fresh pack trading below its honest contents value) — which is exactly the signal worth surfacing. 4b needs the original *per-edition* pool persisted (today only tier-level `original_counts_by_tier` is saved) — add that to the edge fn's metadata write.
- **Interim stopgap until 4b lands — use the secondary ask as the reality-check gate (cleaner than a raw depletion threshold):** suppress/flag any pack whose remaining-pool `gross_ev` exceeds ~3× its own `secondary_ask` when `secondary_available` (the market would arbitrage a real >3× away), OR `depletion_pct` is high. This is 4a, re-expressed against the secondary ask. Ship it now (view migration) for immediate honesty.
- **4c + 4d still apply** (re-key the variance flag; surface weighted coverage).

**Recommendation:** ship the secondary-ask reality-check gate (4a-reframed) + 4c + 4d now as view migrations for immediate honesty, and build 4b (original-distribution EV) as the durable fix so EV reconciles with the secondary ask by construction. **All of Item 4 is still Trevor-review-gated before shipping** (pricing logic). Files: `supabase/functions/compute-topshot-pack-ev/index.ts` (persist original per-edition pool for 4b), DB RPC `compute_pack_ev_per_edition_weighted`, views `pack_ev_latest`/`topshot_pack_reality_top_ev`/`pack_grail_metrics`, `app/api/public/insights/pack-reality/route.ts`, `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (~line 514). **Revert:** `CREATE OR REPLACE` prior view bodies.

---

## Item 5 — mobile moment thumbnails (MED — clean additive fix)

**Root cause:** both the Collection tab (`app/(collections)/[collection]/collection/page.tsx`) and Sniper tab (`app/(collections)/[collection]/sniper/page.tsx`) branch rendering on a `useMobile()` hook (`window.innerWidth < 768`). The **mobile card** layouts were built data-dense and **omit the thumbnail `<img>` entirely**; the desktop tables render it (Collection ~line 2247, 48×64; Sniper ~line 1678, 56×56). The thumbnail URL is already in the data (`getThumbnailUrl(row,…)` / `deal.thumbnailUrl`). Not a CSS-hiding bug — the element doesn't exist in the mobile branch.

**Fix (additive markup, both files):** add a small `<img>` (40×40-ish, `object-fit:cover`, rounded, `loading="lazy"`, `onError` hide) at the start of the mobile card's Row 1, before the player name. Collection: in the `isMobile ? (…)` branch (~lines 1990-2165) Row 1, use `getThumbnailUrl(row, collectionSlug)`. Sniper: in the `isMobile &&` branch (~lines 1482-1612) Row 1, use `deal.thumbnailUrl` (for All Day, swap `width=256`→`width=512`). Exact before/after code is in the research notes; mirror the desktop thumbnail's URL handling. No logic change.

**Verify:** on a <768px viewport (or devtools mobile emulation), Collection + Sniper cards show thumbnails. **Revert:** `git revert`.

---

## Item 6 — pack page dual-link (LOW — feasibility-limited, document the constraint)

**Constraint (confirmed via crawl):** unlike moments (deep-linked by on-chain id), packs aren't cleanly linkable on either side. dapper.market keys pack detail by a **Dapper-internal pack id** (`dapper.market/<league>/search/packs?packSource=marketplace&packDetail=8530`) RPC can't derive from `distId`. The native TS pack URL (`lib/pack-urls.ts topshotPackUrl` → `nbatopshot.com/drop/<distId>`) is a **primary-drop page that 404s for sold-out packs**; All Day has no pack URL in the dist page's scope.

**Recommendation:** don't fake a deep-link. The honest, buildable option is a **"Browse packs on Dapper" link to the league pack grid**: `https://dapper.market/<league>/search/packs` (league seg `nba`/`nfl` via the existing `DAPPER_MARKET_LEAGUE_SEG`; LaLiga has no packs). Add `dapperMarketPacksBrowseUrl(collectionId)` in `lib/pack-urls.ts`/`lib/collections.ts` and render it in the dist-page hero CTA row (~lines 804-853 of `pack/dist/[distId]/page.tsx`) as a `TrackedOutboundLink` (`destination: "dapper_market_packs"`), mirroring the moment dual-link styling, alongside the existing native `buyUrl`. Optionally test whether dapper packs search supports a `?search=<name>` param to pre-filter — if so, deep-link by pack name for better UX; if not, the plain grid link. Flag to Trevor that this is weaker than the moment dual-link and why. Pre-existing bug to fix in the same commit: `PackPageClient.tsx` `buyUrl` still uses the dead `?packListingId=` pattern. **Revert:** `git revert`.

---

## End state

Items 1+2 give RPC the buyer + execution-account data it was discarding (fixing the flagship buyer blind spot and laying the foundation for venue detection). Item 3 makes the platform personable (and was mostly already built). Item 4 fixes a real, embarrassing pricing distortion once Trevor okays the EV definition. Item 5 is a clean mobile win. Item 6 is honestly scoped down. Together with the monitoring (strategy doc §3 + the ecosystem-watch task), RPC stops being blindsided by its own ecosystem.
