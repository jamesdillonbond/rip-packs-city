# Handoff — All Day on-chain offers indexer (fill the edition_offers AllDay gap)

Plain text, iPhone-pasteable. Greenlit by Trevor 2026-06-03 (overriding the "not worth it pre-traction" recommendation). Goal: give NFL All Day a "Best offer" data source so the already-built, collection-agnostic offer display lights up on AllDay moment + edition pages.

CONTEXT — what's already true (verified from Cowork on 2026-06-03)
- The DISPLAY is already done and collection-agnostic. get_edition_high_offer(p_edition_id uuid) reads edition_offers first (then badge_editions), and the moment page (app/moment/[id]/page.tsx, Best offer cell ~L708) + edition page (app/(collections)/[collection]/edition/[slug]/page.tsx ~L419) already render it gated on highest_offer>0. The instant edition_offers gets AllDay rows, the cell appears. NO frontend or DB-schema change is needed for display.
- edition_offers columns (verified): collection_id uuid, external_id text, highest_offer numeric, low_ask numeric, updated_at timestamptz. Keyed (collection_id, external_id). RLS on, anon SELECT-only. This is the write target.
- AllDay editions.external_id = the AllDay editionID as text (a single integer, e.g. "5","46","96"), which equals editionFlowID and editions.play_id_onchain. NOT a setID:playID pair. So an AllDay edition_offers row is (collection_id='dee28451-5d62-409e-a1ad-a83f763ac070', external_id=<editionFlowID as text>, highest_offer=<max open offer for that edition>).
- AllDay collection UUID: dee28451-5d62-409e-a1ad-a83f763ac070.
- Today: edition_offers AllDay = 0 rows; badge_editions AllDay = 1,572 rows but 0 carry an offer; the AllDay marketplace GQL exposes NO offer/bid data (re-confirmed; matches the 2026-06-01 H4 exhaustive probe). cross_market_ask exists for ~3,020 AllDay editions (that's an ASK/floor, already surfaced — do NOT confuse it with offers).
- So the ONLY available AllDay offer source is on-chain: the Dapper offers contract DapperOffersV2 at 0xb8ea91944fd51c43 (in CLAUDE.md's Flow contract list). AllDay NFT type: A.e4cf4bdc1751c65d.AllDay.NFT.

GUARDRAILS
- Direct to main, no branches/PRs. Commit via PowerShell git; re-verify push with git rev-list --count origin/main..HEAD (expect 0).
- Cadence/Flow rule (CLAUDE.md, non-negotiable): use the Cadence MCP to fetch the DEPLOYED DapperOffersV2 source on mainnet and verify the exact event names, fields, and types BEFORE writing any decode. Do not trust this doc's or training-data assumptions about DapperOffersV2's event shape — verify on chain.
- Production reads must route through the existing proxy layer (workers), never direct to rest-mainnet.onflow.org / public-api from Vercel egress. Mirror how the AllDay sales indexer already reads Flow events.
- maxDuration cap 800s on Vercel Pro. curl fails silently in Git Bash — PowerShell Invoke-WebRequest for any REST.
- Claude Code's direct file + on-chain inspection wins over this doc on any disagreement.

STEP 0 (MANDATORY GATE) — recon before you build
Do NOT build the full indexer until you've confirmed AllDay offers actually exist on chain. It is unverified whether the AllDay marketplace even supports "make offer," and if it doesn't, DapperOffersV2 will carry ~0 AllDay-typed offers and this whole effort indexes nothing.
1. Via Cadence MCP: fetch DapperOffersV2 (0xb8ea91944fd51c43) source. Identify the offer lifecycle events (likely an OfferAvailable / OfferCompleted pair — VERIFY the real names + fields: the offered nftID, the nftType, the offer amount/vault, the offerer/proposer, and the completed/purchased flag).
2. Scan a recent window (e.g. last ~7 days of blocks; current AllDay cursor is ~153.66M, ~20-block-batched like the sales indexers) for those events filtered to nftType ending .AllDay.NFT. Count distinct open offers + distinct editions covered.
3. Decision: if there is meaningful volume (say >50 open AllDay offers across >20 editions), proceed to STEP 1. If it's ~0, STOP, write a one-paragraph finding ("AllDay has ~no on-chain offers; the marketplace likely has no offer feature; edition_offers AllDay stays empty by data reality, display correctly hides the cell") and do not build the indexer. Report the count to Trevor either way.

STEP 1 — the indexer (only if STEP 0 clears)
Mirror the established pattern, do not reinvent it:
- Cursor: add event_cursor id='allday_offers' (columns: id text, last_processed_block bigint, updated_at). Start at the current AllDay head block (don't deep-backfill on v1 — open offers are a live snapshot; a few days back is plenty).
- Scan: a new Vercel route app/api/allday-offers-indexer/route.ts that, per tick, reads DapperOffersV2 OfferAvailable + OfferCompleted events for the cursor's block range THROUGH THE PROXY (same egress the allday-sales-indexer uses — match it exactly), filtered to .AllDay.NFT. Keep a per-tick block budget like the sales indexer; advance the cursor.
- Open-offer state: highest_offer per edition = the max amount among offers that are currently OPEN (an OfferAvailable whose nftID has no later OfferCompleted). This is STATEFUL — unlike the offers-sweep (which re-reads a GQL snapshot). Two viable designs; pick per what the events give you: (a) maintain a small open_offers working table keyed by offerID/nftID (insert on Available, delete on Completed), then aggregate max-amount per edition into edition_offers; or (b) if DapperOffersV2 exposes a queryable current-offers view via a Cadence script, prefer reading the current open set directly (simpler, no drift). Confirm which via the Cadence MCP in STEP 0.
- Resolve nftID -> editionFlowID: reuse the EXACT path the AllDay unmapped-resolver uses — searchMomentNFTsV2(byFlowIDs) -> editionFlowID via the topshot-proxy /allday-consumer route. IMPORTANT cap from the 2026-05-25 work: the consumer searchMomentNFTsV2 endpoint hard-caps at 40 edges per page regardless of the first: arg — chunk byFlowIDs at 40, not 200, or 80% of each chunk is silently dropped. (See lib/alldayGraphql.ts / the allday-unmapped-resolver edge fn for the working code.)
- Write: upsert into edition_offers (collection_id='dee28451-5d62-409e-a1ad-a83f763ac070', external_id=editionFlowID::text, highest_offer=<edition max open offer>, updated_at=now()) on conflict (collection_id, external_id). Do NOT write a misleading low_ask — leave low_ask NULL for AllDay rows (the AllDay ask is surfaced separately via get_edition_detail's cross_market_ask path; clobbering low_ask here would fight it). When an edition's last open offer is completed/cancelled, set its row highest_offer to NULL or delete the row so the cell hides again (don't leave a stale offer showing).
- Log: write a pipeline_runs row each tick (pipeline='allday-offers-indexer', ok, rows_written, extra with offers_seen/editions_written/block range) so the weekly silent-degradation + detect_stalled checks can see it.

STEP 2 — wire monitoring + cron (operator + 1 small migration)
- cron-job.org: POST the new route every ~20min (Bearer INGEST_SECRET_TOKEN or ?token=), same as the other indexers. Use www.rippackscity.com (apex 308-redirects).
- pipeline_cadence_watchlist row (Cowork-shippable migration, or fold into the route's first run): INSERT pipeline='allday-offers-indexer', a generous max_silent_minutes (~90), severity 'medium', is_active=true — so detect_stalled_pipelines() covers it.
- Add the route to docs/operations/cron-schedule.md.

VERIFY
- After a few ticks: SELECT count(*), count(*) FILTER (WHERE highest_offer>0) FROM edition_offers WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'; should be >0 if STEP 0 found volume.
- Live: load an AllDay moment/edition page for an edition that has an open offer and confirm the "Best offer" cell renders (it's the same get_edition_high_offer path that already works for Top Shot — no frontend change).
- npx tsc --noEmit clean; deploy READY; pipeline_runs shows allday-offers-indexer ok=true with rows_written>0.

NATURAL FOLLOW-ONS (not required for the Best-offer cell; mention to Trevor, don't auto-build)
- The shared grid/sniper modal (MomentDetailModal) offer parity is in docs/handoff-2026-06-03-audit-followups.md item 2 — once AllDay offers exist, that covers AllDay too.
- The public /insights/offer-spread + /insights/deals boards are Top-Shot-only (topshot_offer_ask_spread / topshot_deals_vs_fmv views). Extending an offer-spread board to AllDay would be a separate insights surface once AllDay offer coverage is real — defer.

REVERT
- git revert <route + any code sha>. Migration revert: DELETE FROM pipeline_cadence_watchlist WHERE pipeline='allday-offers-indexer'; DELETE FROM event_cursor WHERE id='allday_offers'; and (optional) DELETE FROM edition_offers WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'; (removes the AllDay offer rows — display reverts to hiding the cell). Pause the cron-job.org entry.

EXPECTED END STATE
If STEP 0 finds volume: a new allday-offers-indexer route + cursor + cron writing AllDay rows into edition_offers; the Best-offer cell live on AllDay moment/edition pages with no frontend change; deploy READY; pipeline watchlisted. If STEP 0 finds ~0 offers: no build, a recorded finding that AllDay has no on-chain offer market, and edition_offers AllDay correctly stays empty.
