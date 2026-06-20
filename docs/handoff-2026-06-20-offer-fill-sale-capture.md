RPC Claude Code handoff — capture accepted-offer sales (the OffersV2 fill gap) (2026-06-20)

CONTEXT

Measured gap (Cowork, 2026-06-20): accepted Top Shot offers are NOT recorded as sales. The `offers` table has 6,869 `status='filled'` rows since the indexer started 2026-06-03 (5,565 edition + 1,081 subedition + 223 serial), and ZERO of them appear in `sales` (txhash check: 0/6,869). That's ~340 uncaptured TS sales/day — each a real secondary sale that flows through Dapper OffersV2 (contract 0xb8ea91944fd51c43) instead of the NFTStorefront listing path. The on-chain sales-indexer only watches `NFTStorefrontV2.ListingCompleted` + `TopShotMarketV3.MomentPurchased`, so offer-fills are entirely missed. These sales carry a buyer (the offerer) and a definitive price (the accepted offer amount), and serial-offers carry the exact serial — exactly the FMV / Pack-EV / special-serial-premium signal we're trying to complete. This is the single biggest remaining sale-capture hole.

This is sale-ingest code → review-grade, ships via Claude Code (Cowork can't push routes). It ADDS real sales (a capture fix), it does NOT change pricing/FMV logic. Verify file paths + event/payload shapes against the live tree before editing — Claude Code's direct inspection wins over this doc.

KEY FACTS (verified by code inspection this session)

- Indexer: app/api/topshot-offers-indexer/route.ts (Vercel route, Bearer INGEST_SECRET_TOKEN, ~20-min cron, pipeline "topshot-offers-indexer").
- Fill detection (~L243-248): scans `A.b8ea91944fd51c43.OffersV2.OfferCompleted`; `payload.purchased === true` → filledIds; the OfferCompleted event carries `evt.transaction_id` (THE FILL TX) and `evt.blockTimestamp`, but the route currently persists only `status='filled'` + `resolved_at` (~L346-360) and DROPS the fill tx.
- `offers.tx_hash` = the OfferAvailable (creation) tx (~L298), NOT the fill tx — that's why it never matches `sales`.
- Data in hand at fill: offer_id; buyer = the offerer from the matching OfferAvailable (offers.buyer_address, already stored); price = offers.offer_amount_usd (the accepted amount = the sale price, definitive); edition_id (stored); serial + nft_id (stored for offer_type='serial' only — NULL for edition/subedition); fill tx + block time from the OfferCompleted event.
- NOT in hand: seller_address (not in the event) and, for edition/subedition offers, the specific moment/serial that satisfied the offer — both require decoding the fill tx (same Flow REST /v1/transactions/{id}?expand=result decode the sales-indexer already uses in "Step 5b", ~L552-575: TopShot.Deposit.to = buyer, TopShot.Withdraw.from = seller, and the moment id → serial).
- Sales insert shape (mirror it): app/api/sales-indexer/route.ts ~L508-527 — { id, edition_id, collection_id, collection:'nba_top_shot', nft_id, price_usd, serial_number, sold_at, marketplace, source, block_height, transaction_hash, buyer_address, seller_address, ... }. Dedup: unique on transaction_hash in sales_2026.

ITEM 1 (primary) — write a sale when an offer fills (forward path)

In topshot-offers-indexer, at the point OfferCompleted/purchased=true is processed, in addition to flipping status: capture the fill tx (evt.transaction_id) + block time, and write a `sales` row per filled TS offer:
- transaction_hash = the OfferCompleted fill tx (NOT offers.tx_hash). This is the dedup key.
- source = 'offer_fill' (new source value; keeps it distinguishable from 'onchain' listing sales and from 'topshot_gql').
- marketplace = 'topshot'.
- buyer_address = the offerer (offers.buyer_address for that offer_id).
- price_usd = offers.offer_amount_usd.
- sold_at = OfferCompleted blockTimestamp.
- edition_id = offers.edition_id.
- serial_number + nft_id: for offer_type='serial', use offers.serial_number / nft_id directly. For edition/subedition, decode the fill tx (TopShot.Deposit.to = the offerer) to get the moment id + serial that transferred; resolve edition the same way the sales-indexer does. If the decode can't resolve a serial within budget, write the sale with serial_number=0/nft_id null rather than dropping it (a known-price/known-buyer sale is still valuable), OR queue it like unmapped_sales — your call, but don't lose the row.
- seller_address: from the fill tx Withdraw.from via the Step-5b decode (budget the decodes per tick, e.g. cap N like the sales-indexer's TX_DECODE_MAX; serial-offers need a decode only for the seller, edition/subedition need it for seller+moment+serial).
- Persist the fill tx on the offer too (add a column or reuse a field) so a fill is auditable and re-runs are idempotent.

Idempotency: rely on the sales transaction_hash unique constraint + an onConflict/ignore. Edge case to handle: one fill tx could in principle settle more than one offer/moment — if you see that, key the sale on (transaction_hash, nft_id) logic rather than tx alone, or note it.

ITEM 2 (backfill) — recover the 6,869 already-filled offers

Their fill tx was never stored, so a backfill must re-walk `OffersV2.OfferCompleted` (purchased=true) over the block range since ~2026-06-03, match by offer_id to the filled `offers` rows, then decode + write sales exactly as Item 1. Build it as an admin route (e.g. /api/admin/backfill-offer-fill-sales, Bearer INGEST) draining a bounded batch per call behind a cron, mirroring the buyer-backfill cadence pattern. ~6,869 rows + the decode budget → runs over a day or two. Serial offers (223) are cheapest (serial known). 

PRICE NOTE: offer_amount_usd is the accepted offer = the sale price; it's definitive (no DUC-split decode needed for price, unlike the V1 Dapper path). Only seller + (edition-offer) serial need the tx decode.

REVERT
- Code: git revert the commit(s).
- Data: the new rows are isolable by source='offer_fill' — DELETE FROM sales WHERE source='offer_fill' if you need to undo the capture. (Coordinate with FMV: these rows feed fmv-recalc; deleting them reverts their FMV contribution on the next sweep.)

GUARDRAILS (repeat every time)
- Work directly on main. NO branches, NO PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s; the offers-indexer is at 300s — keep the added decode work inside budget (cap decodes/tick) so the route can't blow the cap or the cron-job.org 30s client window (it already returns via after()/202-style — preserve that).
- Before/after a DB-affecting change confirm check_public_security_invariants()=0; no schema change should be needed (you're inserting into sales), but if you add an offers column, keep grants service_role-only.
- Don't broad-read secret-bearing console pages.

EXPECTED END STATE
topshot-offers-indexer writes an 'offer_fill' sale on every TS OfferCompleted; the backfill recovers the ~6,869 historical fills. Verify by re-running the gap check — filled offers with no matching sale should fall toward 0:
WITH f AS (SELECT edition_id,buyer_address,resolved_at FROM offers WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND status='filled' AND resolved_at IS NOT NULL AND buyer_address IS NOT NULL) SELECT count(*) filled, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND s.edition_id=f.edition_id AND lower(s.buyer_address)=lower(f.buyer_address) AND s.sold_at BETWEEN f.resolved_at - interval '2 days' AND f.resolved_at + interval '1 day')) still_missing FROM f;
Net: ~340 additional real TS sales/day captured — with buyer + definitive price + (serial-offer) exact serial — feeding FMV, Pack EV, and the special-serial premium model. This is the largest remaining sale-capture gap.
