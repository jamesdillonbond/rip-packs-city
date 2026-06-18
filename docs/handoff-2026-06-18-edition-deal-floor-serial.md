# Handoff 2026-06-18 — Show the floor listing's SERIAL (+ unlock a Buy link) on edition-level deal alerts

Plain text. Claude Code's direct file inspection wins over this doc. Trevor flagged this as critical: a deal alert that says "$75, 58% below FMV" must say WHICH serial is at $75 — a #3/50 and a #49/50 are very different deals.

## The gap (measured 2026-06-18)

Two deal sources feed alerts:
- Per-serial board (`topshot_underpriced_serials_board`, Pass 2 of `dispatch_due_deal_alerts`): already carries `serial_number` + `nft_id`, so the alert ALREADY shows "#1 · …" and a working Buy link. No change needed.
- Edition-floor board (`cross_collection_deals_board` -> `topshot_deals_vs_fmv` -> `edition_offers`, Pass 1): carries only the floor PRICE. `edition_offers` columns are `collection_id, external_id, highest_offer, low_ask, updated_at` — no serial, no nft_id. So edition deals render "Legendary · Run It Back: Playoff Classics · /50" with NO serial and NO Buy link.

Verified on edition `247:8461` (Vinnie Johnson, Run It Back: Playoff Classics): `edition_offers.low_ask = 75`, but the floor listing's serial is nowhere in our data — `topshot_active_listings` for that edition holds only serial #1 @ $300 (the board only persists serial=1 + last-mint listings, by design for the underpriced-#1 product). `badge_editions.low_ask` is also edition-level (its `series_number` is the badge series, not a moment serial).

## Good news — the formatter already supports it; this is purely a data-plumbing change

`lib/alerts/format.ts`: `dealSerialTag(d)` renders `#${d.serial_number}` and `topshotBuyUrl(d)` builds `nbatopshot.com/moment/${d.nft_id}`. Both already fire when present. The edition payload (Pass 1) just lacks `serial_number` + `nft_id`. So NO format.ts change — get the floor listing's serial + nft_id into the Pass-1 payload and edition deals instantly gain "#34 · …" AND a Buy link (they have none today).

## Fix

1. Capture the cheapest LISTING's serial + nft_id per edition (not just the floor price). Find the authoritative TS `edition_offers.low_ask` writer (the offers/listings sweep — `app/api/cron/offers-sweep` + the TS offers indexer; confirm which sets `low_ask` for TS). If it already hits the TS marketplace per edition for the floor price, switch that call to fetch the floor LISTING (`searchMarketplaceListings`/equivalent, sort PRICE_ASC, first 1) and capture `price + serialNumber + momentId` together — same call, no extra fan-out, price+serial guaranteed consistent.
   CRITICAL: price and serial MUST come from the SAME listing. Do not pair an aggregate floor price from one feed with a serial from another — they'll disagree and mislead.
2. Schema: add `edition_offers.low_ask_serial int` + `edition_offers.low_ask_nft_id text` (nullable). Additive.
3. Board: expose `low_ask_serial` + `low_ask_nft_id` from `topshot_deals_vs_fmv` and propagate through `cross_collection_deals_board` (keep `security_invoker=on`, verify the public `/insights/deals` page still renders).
4. Dispatcher Pass 1 payload (`dispatch_due_deal_alerts`): add `'serial_number', b.low_ask_serial` and `'nft_id', b.low_ask_nft_id`. Done — `dealSerialTag` + `topshotBuyUrl` do the rest.
   (Pinnacle edition deals won't have a TS-style nft_id; leave them serial-less unless the Pinnacle floor feed carries it.)

## Verify

An edition-level deal alert reads e.g. "#34 · Legendary · Run It Back: Playoff Classics · /50 · NBA Top Shot" with a working "Buy on Top Shot" link to that exact moment; the displayed serial's listing price equals the displayed ask.

## Revert

Drop the two `edition_offers` columns + the board/payload additions.

## Note

This is the right long-term shape: every highlighted deal should name its serial. The per-serial board already does; this brings the edition-floor board to parity. It needs the marketplace floor-LISTING query (CC), so it's not Cowork-shippable end-to-end (the schema/board/payload plumbing is, but it's inert until the ingest populates the serial).
