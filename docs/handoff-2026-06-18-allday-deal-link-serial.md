# Handoff 2026-06-18 — AllDay deal listings: direct buy-link (#1) + serial (#2)

Plain text, iPhone-pasteable. Claude Code's direct file inspection wins over this doc on any disagreement.

## Context

AllDay (164) and Pinnacle (23) deals on cross_collection_deals_board carry NO serial and NO nft_id, while Top Shot deals do (605/606 have low_ask_serial + low_ask_nft_id). Root cause: the AllDay floor source cached_listings_v2 has no serial column, and the old allday_edition_floor_ask view was a plain GROUP BY edition_id, min(price). Pinnacle is render-level (no per-serial concept).

Cowork already shipped the data foundation for #1 — migration audit_20260618_allday_floor_ask_carry_listing_ids: allday_edition_floor_ask is now DISTINCT ON (edition_id) ORDER BY price_usd ASC and carries two new columns of the CHEAPEST active listing: floor_listing_resource_id and floor_flow_id (the NFT/moment id). Existing columns floor_ask + floor_ask_listed_at are preserved (same names/types), so the current board leg is unaffected. Verified: 3,904 rows, security_invoker=on, board still 164 AllDay rows, security invariants clean. Revert: re-CREATE the prior body (SELECT edition_id, min(price_usd) AS floor_ask, max(listed_at) AS floor_ask_listed_at FROM cached_listings_v2 WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND completed_at IS NULL AND price_usd>0 AND (expiry_at IS NULL OR expiry_at>now()) AND edition_id IS NOT NULL GROUP BY edition_id;).

Also for context: the alerts go-live test fired clean today — a real subscription delivered 31/31 on email + telegram + discord, 0 failed. The pipeline is proven live.

## Item 1 (do now) — give AllDay deals a direct listing link

The serial is hard (Item 2), but the DIRECT BUY LINK is the real value and is now one wiring step away.

DB: in cross_collection_deals_board, the AllDay UNION leg currently sets low_ask_serial = NULL and low_ask_nft_id = NULL. Change the leg to pull from the upgraded helper: low_ask_nft_id = af.floor_flow_id (where af is the allday_edition_floor_ask join). Leave low_ask_serial NULL (that's Item 2). CREATE OR REPLACE the view (re-fetch the current 3-leg def first with pg_get_viewdef so you reproduce the TS + Pinnacle legs exactly; only touch the AllDay leg's low_ask_nft_id line). Keep the AllDay detail_url as /nfl-all-day/edition/<external_id> (the edition page) — the buy-link below is separate.

Formatter: in lib/alerts/format.ts, the buy-link helper builds a URL from nft_id for per-serial deals (https://nbatopshot.com/moment/${nft_id}). Add an AllDay path: for an edition-level deal where collection_slug='nfl_all_day' and nft_id is present, link to the AllDay moment page — https://nflallday.com/moments/${nft_id} (the safe native link; confirm whether dapper.market/<path>/${nft_id} is preferred for AllDay before using it). So AllDay deal lines get a working "View listing" link, parity with TS.

Verify: an AllDay deal in the digest now carries a clickable listing link to the specific cheapest moment; cross_collection_deals_board AllDay rows show low_ask_nft_id populated; dispatch_due_deal_alerts materialization stays under 90s; check_public_security_invariants() / check_secdef_anon_execute_violations() still clean.
Revert: git revert the formatter; re-CREATE the board view without the low_ask_nft_id mapping.

## Item 2 (optional, lower priority) — recover the AllDay serial

The floor listing's serial is NOT in any current table: cached_listings_v2 has no serial column, and joining floor_flow_id to wmc.moment_id / sales.nft_id returns null (those listed moments aren't held by tracked wallets or previously sold). So the serial must be fetched on-chain / from GQL.

Two paths:
- Capture at ingest: in the AllDay V1 Dapper listings indexer (the route/worker that writes cached_listings_v2 for AllDay), resolve the NFT's serial_number when the listing is seen (AllDay consumer GQL getMintedMoment(<flow_id>) → serialNumber, via the topshot-proxy /allday-consumer route) and store a new serial_number column on cached_listings_v2. Then allday_edition_floor_ask carries it → board low_ask_serial → the formatter already prints "#<serial>".
- Or a backfill: a one-off/cron that resolves floor_flow_id → serial for the editions currently on the deal board only (~164), cheaper than all 18k listings.

Payoff is modest (AllDay is less serial-driven than TS, and Item 1 already gives the buy link), so treat this as a nice-to-have. Pinnacle stays serial-less by design (render-level).

## Guardrails

- main only, no branches/PRs; PowerShell git; re-verify push with git rev-list --count origin/main..HEAD.
- Re-fetch cross_collection_deals_board's current def before CREATE OR REPLACE (don't reproduce from memory — CC's AllDay leg from dd7e2bf must be preserved).
- Log the DB changes in CLAUDE.md + ledger with revert paths; also log the Cowork migration audit_20260618_allday_floor_ask_carry_listing_ids (Cowork doesn't edit ledger.md to avoid the large-file truncation hazard).

## Expected end state

AllDay deals carry a direct listing link (Item 1) like Top Shot; optionally the floor serial too (Item 2). Pinnacle deals remain link/serial-less (render-level). The helper-view foundation is already live.
