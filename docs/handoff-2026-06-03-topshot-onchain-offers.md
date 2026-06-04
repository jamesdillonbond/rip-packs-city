# Scope — Top Shot on-chain offers intelligence (OffersV2 indexer + depth/identity/fill)

Plain text, iPhone-pasteable. Scope + phased build plan for Trevor's "enhance what we know about TS offers" question. Builds directly on the AllDay on-chain offers indexer shipped 2026-06-03 (cc8a3e7 + audit_20260603_allday_offers_indexer_state).

## The reframe: (a) and (b) are one build, not a fork

The recon dissolved the choice. Two facts:
- The rich `offers` table ALREADY EXISTS with the full intelligence schema — columns: id, collection_id, edition_id, moment_id, serial_number, buyer_address, offer_amount_usd, offer_type, fmv_at_offer, pct_vs_fmv, status, source, created_at, expires_at, resolved_at. It's abandoned (0 rows) but the depth/identity/fill shape is done. (b) is a POPULATION problem, not a schema-design problem.
- The on-chain TS indexer is literally the AllDay indexer with nftType filter `.TopShot.NFT` and the key taken from offerParams. Same OffersV2 events, same Flow-REST egress, same open-offer state pattern (allday_open_offers).

So a single indexer can write per-offer rows into `offers` (the (b) intelligence) AND keep `edition_offers.highest_offer` correct — now catching the TopShotSubedition (parallel) and specific-NFT (serial) offer classes the GQL aggregate is blind to today ((a)). **(a) is a free byproduct of (b)'s foundation.** Recommendation: build it once, phased — capture first, intelligence surfaces after the data accrues.

Already shipped this session (prereq): `audit_20260603_harden_offers_table_revoke_anon_writes` — the `offers` table had full anon/authenticated write grants (INSERT/UPDATE/DELETE/TRUNCATE); revoked to service-role writes (anon/auth SELECT only) before it gets bidder-identity data. Revert: re-GRANT (don't).

## PHASE 1 — capture foundation (delivers (a)'s fix immediately + starts accruing fill history)

GOAL: a `topshot-offers-indexer` route + state that populates `offers` and maintains `edition_offers.highest_offer` for Top Shot. The instant it runs, the Best-offer cell on TS moment/edition pages becomes correct for parallels + serial offers, and `offers` starts accumulating the depth/identity/fill data Phase 2 needs.

GUARDRAILS (CLAUDE.md): direct to main; commit via PowerShell git, verify push with git rev-list --count origin/main..HEAD (expect 0); Cadence MCP MUST verify the deployed OffersV2 (DapperOffersV2 0xb8ea91944fd51c43) event schema before writing the decode — confirm OfferAvailable/OfferCompleted field names + the offerParams keys + the completed/purchased flag + accepted serial; production reads route through the existing proxy (mirror allday-offers-indexer exactly); maxDuration cap 800s.

WHAT TO BUILD (clone allday-offers-indexer, change the filter + key derivation):
- Route app/api/topshot-offers-indexer/route.ts. nftType filter `.TopShot.NFT`. event_cursor id='topshot_offers' (start at current head ~153.66M; don't deep-backfill — open offers are a live snapshot). Per-tick block budget like the AllDay/sales indexers; advance cursor; write a pipeline_runs row (pipeline='topshot-offers-indexer') with offers_seen / editions_written / by_type counts.
- Key derivation from offerParams (recon confirmed 3 types in the last 2,500 blocks: TopShotEdition 22, NFT/serial 5, TopShotSubedition/parallel 4) — see Decision 2 below for the exact mapping.
- Open-offer state: generalize the allday_open_offers pattern (offer_id text, edition_id text, amount numeric, updated_at) — for TS add the offer_type + offerer + a collection discriminator (or a parallel topshot_open_offers). Insert on OfferAvailable, remove on OfferCompleted. highest_offer per edition = max amount among currently-open offers for that edition.
- Per-offer write into `offers` (the rich table): on OfferAvailable insert (collection_id=TS, edition_id, moment_id+serial_number for serial offers, buyer_address=offerer, offer_amount_usd=amount, offer_type in {edition,subedition,serial}, fmv_at_offer + pct_vs_fmv enriched from the latest fmv_snapshot at write time, status='open', source='onchain', created_at, expires_at if in params). On OfferCompleted update the matching row: status='filled' (purchased) or 'cancelled', resolved_at, and for fills the accepted serial. Idempotency: add an on-chain offer_id (text) + tx_hash to `offers` (small migration) and upsert on offer_id so re-scans don't double-insert.
- edition_offers maintenance: upsert (collection_id=TS, external_id=<resolved edition key>, highest_offer=<max open offer for that edition>, updated_at=now()). Don't clobber low_ask. When an edition's last open offer closes, set highest_offer NULL / delete the row so the cell hides.

COWORK-SHIPPABLE NOW (de-risk Phase 1 before CC writes the route): the small `offers` enrichment migration (add offer_id text + tx_hash text + unique index for idempotency; indexes on (collection_id, edition_id), (buyer_address), (status, resolved_at)); finalize RLS (revoke anon SELECT too once surfaces go through SECDEF views — see Phase 2); the topshot_open_offers state table (or generalize allday_open_offers). HELD to avoid racing CC on the `offers` table while it's mid-build — coordinate the boundary first.

VERIFY (Phase 1): offers rows accruing with all 3 offer_type values; edition_offers TS rows now include parallels/serials (spot-check an edition with a known subedition offer); a TS moment/edition page Best-offer cell reflects an on-chain offer; pipeline_runs ok=true rows_written>0; add a pipeline_cadence_watchlist row (~90m) + cron-job.org 7,27,47 * * * * (operator, Bearer INGEST_SECRET_TOKEN) mirroring AllDay.

## PHASE 2 — the intelligence surfaces (sequence AFTER ~1 week of accrual)

These are the differentiation — nobody surfaces them. Each = a security_invoker view (Cowork) + optional public /insights surface (CC, rpc-insights-qa checklist). Reads of bidder-identity data go through SECDEF views/RPCs, NOT raw anon SELECT on `offers`.
1. Offer depth — per edition: open-offer count + top offer + the offer ladder ("5 standing offers, top $32, then $28/$25..."). Instant once Phase 1 runs.
2. Fill-rate-at-N%-of-floor — THE novel stat. From `offers` status='filled' vs total, bucketed by pct_vs_floor (or pct_vs_fmv), per edition/set/tier: "offers at 80-90% of floor get taken 34% of the time." Needs accrued OfferCompleted history. No competitor has this.
3. Whale/insider bidding cross-ref — join offers.buyer_address to the institutional/insider wallet analytics (wallet_holdings_snapshot / the tracked-wallet set) -> "a tracked whale is bidding on X." Concierge + a board.
4. Offer velocity — new-offer rate per edition/set as a demand pulse (offers/day trend).
5. GQL-vs-chain reconciliation -> v_offer_sanity_flags (same spirit as v_fmv_sanity_flags, which is now wired into the weekly health check): flag editions where the GQL highestOffer disagrees with the on-chain open-offer max (lag / withdrawn bids included). Truth = on-chain create/cancel/accept events.

## Cowork vs Claude Code split
- Cowork (me, now/next): the `offers` enrichment + idempotency migration; the open-offer state table; the edition_offers aggregation if expressed as a DB function; all Phase-2 views + v_offer_sanity_flags; RLS finalization. (Write-grant hardening already shipped.)
- Claude Code: the indexer route (Flow event scan + proxy egress + Cadence-MCP OffersV2 verify); the /insights surface routes/pages/OG; cron wiring is operator.

## Decisions (RESOLVED 2026-06-03 with Trevor)
1. PUBLIC. Depth + fill-rate ship as public /insights surfaces (the distribution wedge). Raw per-offer bidder identity (buyer_address) stays concierge/internal-only — expose only aggregates publicly; reads via SECDEF views, not raw anon SELECT on `offers`.
2. PARALLEL MAPPING — confirmed at the schema level:
   - TS SET-based parallels ARE already distinct editions, each keyed by its own integer setID:playID (verified: play 127 -> Base 10:127, Cosmic 2:127, Denied! 4:127, Holo MMXX 5:127, Metallic Gold LE 7:127, Rookie Debut 8:127). So an on-chain TopShotEdition offer (setId:playId) maps DIRECTLY to the right parallel edition's external_id — no rollup; each parallel carries its own highest_offer. (The 22/31 TopShotEdition offers in the recon are this case.)
   - Canonical rows only: TS editions = 9,042 real setID:playID rows + 7,310 INERT UUID:UUID dupe rows (trigger-gated by editions_block_topshot_uuid_dupe). Match offers to the integer-keyed rows; ignore the UUID-keyed dupes.
   - Subedition offers (on-chain TopShotSubedition carries setId:playId:subeditionId; 4/31 in recon) have NO distinct RPC edition row — RPC models parallels as separate SETS, not as same-set subeditions. Roll a subedition offer up to its base setId:playId edition's external_id and tag offer_type='subedition' (store subeditionId in `offers` for later). FLAG: making subedition parallels their own offer line would require RPC to first model subeditions as editions — separate data-model work, OUT OF SCOPE here.
   - Serial (NFT) offers: resolve nftId -> moments.nft_id -> edition_id + serial_number.
3. PHASE-2 ORDER (Trevor deferred -> my call): DEPTH first, FILL-RATE second. Depth is instant (available the moment Phase 1 writes rows, no accrual) so it ships as the first visible /insights surface and validates the capture; fill-rate is the real differentiator but needs ~1 week of OfferCompleted history to be meaningful, so it ships second as the headline. Whale cross-ref + velocity + v_offer_sanity_flags follow.

## Recommendation in one line
Build the one OffersV2 TS indexer into the existing `offers` table + edition_offers (Phase 1) — that ships (a)'s subedition/serial fix immediately and lays (b)'s foundation; then sequence depth -> fill-rate -> whale/velocity/reconciliation (Phase 2) as the data accrues.
