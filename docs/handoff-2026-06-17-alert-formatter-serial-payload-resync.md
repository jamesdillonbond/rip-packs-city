# Handoff 2026-06-17 — Alert formatter is out of sync with the new serial-level deal payload (live render bug)

Plain text. Claude Code's direct file inspection wins over this doc. SUPERSEDES both buy-link handoffs (handoff-2026-06-17-alert-marketplace-buy-links.md and -url-correction.md) — the data they were waiting on is now in the payload.

## What happened

The deal-alert dispatcher (DB fn `dispatch_due_deal_alerts`) was rewritten to the new serial-level Atlas deal source (it now also returns `serial_enqueued`). The enqueued `alert_deliveries.payload.deal` changed shape — but `lib/alerts.ts` (the `DealPayload` type) and `lib/alerts/format.ts` still read the OLD field names. So the data layer moved and the formatter didn't follow.

Impact: every deal alert now renders with missing prices and a wrong link. It does NOT crash (so deliveries send "successfully" with broken content — the insidious kind): `money()` returns "—" for the now-absent `low_ask`/`fmv_usd`, and `absUrl(undefined)` falls back to the homepage. A deal currently reads like "Cade Cunningham / Bag Work / — ask · 50% below FMV —" linking to rippackscity.com. `tsc` stays clean because the DB payload isn't typechecked against the TS type. No real users are hit yet (0 subscriptions), but the next real alert is broken — fix before any real alert goes out.

## The new payload (captured live 2026-06-17 from a real dispatch)

deal = { kind:"first", tier:"COMMON", nft_id:"51636784", ask_usd:59, set_name:"Bag Work", confidence:"HIGH", moment_url:"/moment/51636784", external_id:"244:8396", listing_url:"https://dapper.market/nba/moment/51636784", player_name:"Cade Cunningham", discount_pct:50, discount_usd:59.08, serial_number:1, thumbnail_url:"https://assets.nbatopshot.com/…(absolute)", serial_fmv_usd:118.08, collection_slug:"nba-top-shot", edition_fmv_usd:3.07, estimate_quality:"tight", circulation_count:1149 }

Get the authoritative shape from the live fn (read `dispatch_due_deal_alerts` / its deal-builder body, or dispatch into a scratch sub) in case fields differ from this one sample.

## Field map (old format.ts read -> new payload field)

- low_ask -> ask_usd
- fmv_usd -> serial_fmv_usd  (the serial-adjusted FMV that discount_pct is computed against: 1 - 59/118.08 = 50%. edition_fmv_usd 3.07 is the base-edition FMV — show as secondary context if you like, but the headline FMV for a per-serial deal is serial_fmv_usd)
- detail_url -> moment_url  (RPC /moment/<nft_id> details page; relative, absUrl-friendly)
- collection_name -> collection_slug  (derive a display label or drop; dealTitle still works — player_name is present)
- NEW to surface: serial_number, kind ("first" = #1, plus jersey/perfect/etc.), estimate_quality, tier, circulation_count

## Fix

1. Update `DealPayload["deal"]` in lib/alerts.ts to the new shape.
2. Update lib/alerts/format.ts deal rendering in ALL builders (buildTelegramMessage, buildDiscordEmbeds, buildEmailMessage HTML + text leg):
   - ask = money(deal.ask_usd); fmv = money(deal.serial_fmv_usd); discount = pct(deal.discount_pct).
   - details link = absUrl(deal.moment_url).
   - show the serial: e.g. "#1" (kind==="first") / jersey / perfect, since these are per-serial deals now (a #1 of a $3 edition selling at $59 vs $118 serial FMV is the actual story).
3. Buy links — the data is now all present, so this CLOSES the buy-link + Dapper work; delete the `topshotEditionMarketUrl` null stub:
   - Buy on Top Shot = `https://nbatopshot.com/moment/${deal.nft_id}` (the verified per-moment page used everywhere in the repo — NOT the 404-ing /marketplace/editions/ path).
   - Dapper = deal.listing_url (already absolute; render when present).

## Verify

Stage a deal sub, dispatch, send to a channel: the message shows real ask / serial FMV / discount, the serial (#1 etc.), a working Buy-on-Top-Shot (/moment/<nft_id>) link, and a Dapper link.

## Guardrails

Direct to main, no PR. tsc clean. Note this also means the serial filters (jersey/last-mint/never-sold) are now feedable — confirm whether the dispatcher already enforces them given `serial_enqueued`.
