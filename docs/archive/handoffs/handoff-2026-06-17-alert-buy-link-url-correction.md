# Handoff 2026-06-17 — Top Shot buy-link URL is wrong (correction)

Plain text. Claude Code's direct file inspection wins over this doc. This SUPERSEDES the URL in handoff-2026-06-17-alert-marketplace-buy-links.md (that shipped `2dd19af` with a 404-ing format).

## The bug

The buy link shipped as `https://nbatopshot.com/marketplace/editions/<setID>/<playID>` (on-chain integer ids). That path 404s on Top Shot. Confirmed live: a real deal (Hugo González, "Rookie Debut", set/play 219/7399) produced `…/marketplace/editions/219/7399`, which errors.

The same broken format is also in `app/api/sniper-feed/route.ts:1453` (`tsBuyUrl`) — so the Sniper "View Listing" links are broken the same way. Fix both.

## The correct URL

`https://nbatopshot.com/listings/p2p/<setUUID>+<playUUID>` — Top Shot's INTERNAL UUIDs, set first, joined with a literal `+`. Verified against Trevor's working link:
`…/listings/p2p/891987bc-a5c0-404e-8486-1735a330a81a+aebb2e8a-43c6-44f4-9611-56b37360e2a0`
where `891987bc…` = the "Rookie Debut" SET uuid and `aebb2e8a…` = the PLAY uuid.

## Why it can't be built from the deal board today (the data gap)

- SET uuid: available cleanly — `editions.set_id` -> `sets.external_id` (verified: set 219 -> `891987bc…`).
- PLAY uuid: NOT stored on canonical (integer-keyed) editions. It only exists in the legacy inert "UUID-dupe" edition rows (`external_id = <setUUID>:<playUUID>`), and those have no reliable join key back to the canonical edition: canonical TS editions have `player_id` NULL, their on-chain ids are NULLed on the dupes, and (set + player_name) is not unique for players with multiple plays in a set. So there's no robust int-pair -> playUUID map in the DB right now.
- Note: the TS GQL ingest DOES receive `play.id` (the play uuid) per edition — it's the old UUID-fallback key in `app/api/ingest/route.ts` `buildEditionKey`. It's just not persisted on the canonical row.

## Fix

### Step 1 — immediate, make it safe (do first)

In `lib/alerts/format.ts`, have `topshotEditionMarketUrl` return `null` (or drop the rendered "Buy on Top Shot" link) so alerts stop emitting 404 links. The RPC `detail_url` link stays (it works and carries the FMV + edition context). Apply the same guard to `sniper-feed` `tsBuyUrl` (fall back to `nbatopshot.com/moment/<momentId>`, which IS valid there since the sniper feed HAS a moment id, unlike the edition-level deal). Ship this now; it's a few lines.

### Step 2 — proper fix (Trevor to pick a path)

Option A — persist the Top Shot UUIDs on editions:
- Add `play_uuid text` (and optionally `set_uuid text`) to `editions`.
- Persist `play.id` in the TS GQL ingest going forward (it's already fetched).
- Backfill history by re-fetching `searchEditions` (returns both `play.flowID` and `play.id`, i.e. 7399 -> `aebb2e8a…`) — that's the clean key, not the fragile set+player match.
- Then build `https://nbatopshot.com/listings/p2p/<sets.external_id>+<play_uuid>` in the deal builder/formatter. Fixes sniper-feed too.

Option B — drive the link off the Atlas per-serial listings feed (already in progress):
- That feed yields the cheapest LISTED moment's id, so use the verified-working `https://nbatopshot.com/moment/<momentId>` — more precise (lands on the exact cheapest serial) and needs no UUID backfill. Bundle with the serial-filter / Dapper work that depends on the same feed.

Recommendation: B if the Atlas feed lands soon (cleaner + more precise + unblocks Dapper and the serial filters in one go); A if you want the edition-listings page independent of Atlas. Either way, do Step 1 now so no 404 links go out in the meantime.

## Verify

After Step 1: a TS deal digest shows no "Buy on Top Shot" link (or only valid ones). After Step 2: the link opens `…/listings/p2p/<setUUID>+<playUUID>` (Option A) or `…/moment/<id>` (Option B) and lands on real listings.

## Revert

Step 1 is the revert (helper -> null). Step 2 is additive (new column / new payload field).
