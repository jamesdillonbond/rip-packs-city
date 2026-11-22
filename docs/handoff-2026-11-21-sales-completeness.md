# Sales completeness — what is proven, what is not, and the Panini plan (2026-11-21)

Trevor, 11-21: "keep going and don't stop until you're 100% sure" → "Dig deeper into how we can fix panini and any others that aren't 100% confirmed."

## Proven exact for 11-15 02:00Z → 11-22 02:00Z (independent source, same window)

| Collection | Independent source | Result |
|---|---|---|
| Top Shot | Flow events: NFTStorefrontV2/V1 ListingCompleted(purchased), TopShotMarketV3.MomentPurchased, OffersV2.OfferCompleted(purchased); V1 sweeps priced per NFT from tx results | 22,269 / $49,440.12 + 36 / $49.00 + 4,487 / $64,700 — exact after fixes (the newest ~15 min always sit in `unmapped_sales` for the resolver) |
| All Day | same | 3,432 / $2,581.28 + 81 / $139 + 764 / $4,074 — exact after fixes |
| Pinnacle | same (`pinnacle_sales`) | 1,136 / $8,419 — exact |
| Golazos | same | 72 / $39.71 — exact |
| Candy | Magic Eden activities (all 362 symbols) + archive-node chain census of every Candy collection account (11-22) | Magic Eden 137 / 50.928 SOL listed — exact; **plus 57 fills on other Solana marketplaces found 11-22 and now captured → 194 / $6,985**; dollars are buyer-paid (on-chain per tx) |

Census scripts were run from a cloud session (Flow REST `/v1/events`, 250-block chunks, 8 workers: 7 days in ~4 min). Worth turning into a scheduled weekly check — see "Next".

## Fixed tonight (ledger 11-21 ~7:00 PM and ~7:55 PM PT)

1. All Day `NFT`-type offer fills were never recorded (24/24 that week, 81 since 10-10) → chain fallback in `writeAllDayOfferFillSales`; 80 backfilled, 1 unresolvable ($3).
2. All Day V1 multi-NFT sweeps recorded the basket total per NFT → per-NFT pricing via `decodeV1MultiSaleTx`; 47 rows since Sept corrected.
3. Top Shot `NFT`-type offer fills: 3/234 dropped → path 5 (chain) in `buildOfferFillSales`; 3 backfilled.
4. Candy buyer-paid backfill reads 4 transactions at a time (was ~50 per run on history).

## Not yet proven

- **Panini** (below) — the one real gap.
- ~~Candy sales that settle outside Magic Eden~~ → **found and fixed 11-22** (section below).
- **All Day history before 10-10-2026 (sized 11-22, not fixed — a decision for Trevor).** Two full-day chain censuses against `sales`:
  - **Offer fills are missing.** 2026-01-15: 274 All Day `OffersV2.OfferCompleted` fills on chain, **13** in `sales` (~15 % of that day's 1,718 purchases). 2026-02-08: 406 offer fills on chain. The All Day offer lane exists only since 10-10-2026 and was built forward-only on a 09-24 sizing (~2.6 % of sales, ~20/day); in Jan–Feb offers were 15–27 % of the day. Top Shot's lane starts 06-03-2026, so its earlier history very likely has the same hole (not measured).
  - **Some multi-NFT sweeps are short.** 01-15: per-transaction counts match the chain exactly (378/328/134/2). 02-08: chain has 44 four-NFT sweeps, `sales` 28 — about 16 sweeps (up to ~48 NFTs) recorded with fewer rows. A 40-transaction random sample of Dec–Feb single-row txs found 7 that actually bought 2–4 NFTs (13 missing), all `allday_studio_history_v1`, not parked in `unmapped_sales`.
  - **Does not touch** this week, FMV (30-day window) or anything since 10-10. **Does** under-state All Day volume/sale counts on history charts and any all-time figure, by roughly 15–25 % for Dec 2025 – Feb 2026.
  - **Fix if wanted:** walk OffersV2 + V1 storefront events over the history window (the census script does a day in ~4 min, ~50 min per quarter), resolve each NFT to its edition, insert as `offer_fill` / per-NFT rows. Flow REST could not serve Dec 2025 blocks here (older spork), so that month needs a spork-aware access node.
- **Dollar conversion** for Candy uses the trade day's SOL rate (daily, 00:00 UTC basis); trackers quoting live SOL differ by a few %.

## Panini — why it is incomplete

- Sales come only from each card's SALES HISTORY → RECENT list (`nftSalesData`, newest 20), read when the runner walks that card. Nothing marketplace-wide is known: hand-built `/onepanini` POSTs get HTTP 426, the grid (`getMarketPlaceList`) is listings-only, Panini's chain is private (no public RPC/explorer for marketplace trades), the Ethereum bridge/OpenSea side is a subset.
- The window is not the problem: 49,067 reads, only 100 editions ever showed a gap. **Every sale is eventually captured — late.**
- Throughput is: 7,459 editions walked in the last 24 h out of 53,730 (a ~7-day rotation, stalest first). Sale → `panini_sales` median 57 h, p90 117 h. Result: the trailing-7-day Panini figure counts ~1/3 of its last three days (11-19: 265, 11-20: 169, 11-21: 24 vs 600–1,400 a normal day) and climbs for ~5 days.
- Hot-first ordering alone is not enough: of 14,519 sales (11-01..11-14), 75 % were on editions with a sale in the prior 14 days, but only 52 % of the dollars — 216 sales ≥ $100 were 59 % of the volume, and big sales are mostly on cards that had not traded recently.

## Panini — options, best first

1. **Find a marketplace-wide feed (needs Trevor's browser, ~15 min).** Run the runner in capture mode (`PANINI_DISCOVERY_ONLY=1`, CDP Chrome) and click every activity-like view on nft.paniniamerica.net: marketplace sort options (recently sold / recently listed), any "Activity" / "Sales" / "Top sales" page, a player page's sales tab, profile activity. Every `/onepanini` op lands in the ops-capture file; one op that lists sales across cards fixes Panini outright (the runner already signs requests natively by clicking). Also capture the grid response with each sort to see whether `crypto_sale_count` changes per edition.
2. **Grid-driven walk priority (code, runner + route).** Each FULL run already enumerates `getMarketPlaceList`, whose items carry `crypto_sale_count` and `buy_now_price`. Send those with the grid batch; the route stores the last-seen count per edition; editions whose count rose — or that vanished from the grid since the last pass (their last listing sold) — go to the front of `priority_pskus`. That aims the walk at editions that just sold, including rare high-dollar ones. Limits: covers only listed editions and only what the 4-min-per-sport enumeration reaches; verify first that `crypto_sale_count` is a lifetime sale count (option 1's capture answers it).
3. **More throughput.** ~5 s per card today vs 3.5 s measured on a fresh tab (11-03). A second Chrome profile/tab walking in parallel would roughly double the rotation without any new source.
4. **Report honestly until then.** For posts: a Panini figure for the 7 days ending 5 days ago is complete; the trailing 7 days is a floor. Public surfaces already gate a Panini 24h/7d total on "sale lag < 1 day" (docs/strategy/panini-multi-product-2026-09-28.md).

## Candy off Magic Eden — found and fixed 11-22

- **Archive census** (mainnet-beta; publicnode's signature history reached back only ~1.5 days, so the first census and the lane's first runs under-read): all 398 Candy collection accounts 11-06 → 11-22 12:00 UTC (77,220 signatures) ∩ program `7Aru291A…` (109,249) and Tensor `TCMPhJ…` (1,173,088) → 1,414 candidate transactions, all read.
- **Found:** 68 fills on 7Aru (62 buys, 6 accepted bids; ~45 SOL; biggest 10.4, 9, 7.5 SOL) and 1 Tensor accepted bid — **none were in `sales`**. A 298-tx random sample of older signatures showed no other venue. 2 more 7Aru buys were paid in a non-SOL token (not priced, reported).
- **Fixed:** `/api/ingest/candy-chain-sales` (hourly :11) decodes 7Aru and Tensor `BuyCore` + `TakeBidCore` from each collection account behind a cursor, accepts a signature listing only when it is proven complete (reaches the cursor/floor, or ends on an archive RPC), reads v1 transactions, and offers fills to the drain with their venue (`solana_7aru` "Other Solana marketplace", `tensor`). The back-fill was parked once from the session; the drain wrote all of it by 12:20 PM PT 11-22 (2 were sealed packs → `candy_pack_sales`).
- **This week's Candy (11-15 02:00Z → 11-22 02:00Z) is now 194 sales / $6,985** (Magic Eden 137 / $3,939, other Solana marketplace 56 / $3,045, Tensor 1 / $0.75). The earlier "137 / exact" was exact for Magic Eden only.

## Next

- Trevor: the 15-minute capture session in option 1.
- Code: option 2 once the capture confirms what `crypto_sale_count` means.
- Make the Flow + Magic Eden census a weekly scheduled check (posts and the market-pulse board read the same tables).
