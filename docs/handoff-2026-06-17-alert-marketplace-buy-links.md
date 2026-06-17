# Handoff 2026-06-17 — Add Top Shot marketplace buy link to deal alerts

Plain text (iPhone-pasteable). Claude Code's direct file inspection wins over this doc.

## Context

Deal alerts (Telegram / Discord / email) currently link only to RPC's own edition page (`detail_url`, e.g. `/nba-top-shot/edition/247%3A8464`). That's the FMV/intelligence view but not a buy link. Trevor wants the alert to also link out to where you can actually buy it — the Top Shot marketplace (and Dapper Market). This handoff adds the Top Shot marketplace link; see the Dapper note at the end for why that one waits.

The omni-channel alerts are otherwise fully live (all 3 channels verified, both crons wired + logging).

## What's available on the deal payload

`build_deal_alerts_for_subscription` returns each deal with (among others): `collection_slug` (LONG-form, e.g. `nba_top_shot` / `disney_pinnacle`), `external_id` (TS = `setID:playID` like `247:8464`; Pinnacle = render_id), `detail_url`, `player_name`, `set_name`, `low_ask`, `fmv_usd`, `discount_pct`. The formatter (`lib/alerts/format.ts`) reads `d.payload.deal`.

## Verified URL

The Top Shot EDITION marketplace page (lists every live listing for the edition, sorted by price) is `https://nbatopshot.com/marketplace/editions/<setID>/<playID>`. This is already in production use in `app/api/sniper-feed/route.ts:1453` (`tsBuyUrl`), so it's verified — not guessed. The deal's `external_id` is exactly `setID:playID`, so no extra data is needed.

## Fix — lib/alerts/format.ts

1. Add a small helper near the top (beside `absUrl`):

   function topshotEditionMarketUrl(deal) {
     if (!deal || deal.collection_slug !== 'nba_top_shot') return null;
     const m = String(deal.external_id || '').match(/^(\d+):(\d+)/);
     return m ? `https://nbatopshot.com/marketplace/editions/${m[1]}/${m[2]}` : null;
   }

   (Returns null for Pinnacle and anything non-int-keyed, so no broken link ever renders. AllDay/Golazos aren't in the deal board yet; when they are, extend this with their edition URLs — AllDay's builder already exists as `buildMarketplaceUrl` in `app/api/allday-sets/route.ts:124`.)

2. Render it as a second link wherever the deal's `detail_url` is shown today, label it clearly as the buy action, keep the RPC `detail_url` as the "details/FMV" link:

   - buildTelegramMessage: after the existing `<a href="${absUrl(deal.detail_url)}">${title}</a>` + price line, append (only when the helper is non-null): ` · <a href="${u}">Buy on Top Shot ↗</a>`.
   - buildDiscordEmbeds: keep `url: absUrl(deal.detail_url)` on the title (FMV context); when the helper is non-null, add a field `{ name: 'Buy', value: \`[Top Shot ↗](${u})\`, inline: true }` (Discord embed field VALUES render markdown links; field NAMES don't). 
   - buildEmailMessage (both the HTML and the text legs): add a "Buy on Top Shot ↗" anchor/line in each deal row next to the title link, when non-null.

3. No change to the FMV-alert (`isFmv`) rows — those are per-edition threshold alerts, same edition-URL helper applies if you want, but deals are the priority.

## Dapper Market — why it waits (do NOT ship a generic link)

The existing `dapperMarketMomentUrl(collectionId, momentId)` (lib/collections.ts:347) is MOMENT-keyed — `https://dapper.market/<seg>/moment/<momentId>`. A deal alert is edition-level and carries no specific moment id, and there is NO verified edition/search Dapper URL in the repo (only moment + `search/packs`). Linking to a generic `dapper.market/nba` page is a dead-end, so hold Dapper until the per-serial live listing feed lands and the deal can carry the cheapest-listed moment id — at which point BOTH `nbatopshot.com/moment/<id>` and `dapperMarketMomentUrl(..., <id>)` become available (precise, moment-level, for TS/AllDay/Golazos). This is the same listing-feed dependency as the serial/jersey/last-mint filters; bundle it there.

## Verify

Stage a TS deal sub (min_discount ~25), dispatch, send to a channel, and confirm the message shows a working "Buy on Top Shot" link that opens `nbatopshot.com/marketplace/editions/<setID>/<playID>` with the cheap listing at the top of the book.

## Revert

Remove the helper + the three rendered links. (Pure additive; no DB or schema change.)

## Guardrails

Direct to main, no PR. PowerShell git; `git rev-list --count origin/main..HEAD` == 0 after push. `npx tsc --noEmit` clean. Log in ledger/CLAUDE.md.
