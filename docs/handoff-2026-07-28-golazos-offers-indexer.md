# Handoff — Golazos offers indexer (staged inert; needs one on-chain recon)

**Date:** 2026-07-28 · **Author:** Claude Code (interactive)
**Goal:** fill the one genuinely-open Golazos badge gap — `highest_offer` 0/218 — by
surfacing DapperOffersV2 "Best offer" on Golazos edition/moment pages, the same way
AllDay does.

## What shipped (safe, inert)

1. **Migration `audit_20260728_golazos_open_offers_scaffold`** (applied to prod) —
   `public.golazos_open_offers` (offer_id PK, edition_id, amount, updated_at),
   mirroring `allday_open_offers`. RLS on, no policy, anon/authenticated REVOKED
   (verified `has_table_privilege` false; `check_public_security_invariants()` = 0;
   `rls_off` = 0). Seeded `event_cursor('golazos_offers', 0)`.
2. **Route `app/api/golazos-offers-indexer/route.ts`** — a faithful mirror of the
   LIVE `allday-offers-indexer`, re-parameterized for Golazos
   (`GOLAZOS_COLLECTION_ID`, `.Golazos.NFT` suffix, `golazos_open_offers`,
   `event_cursor('golazos_offers')`, slug `laliga_golazos`). **No cron calls it.**

Nothing runs until someone with Flow REST egress runs the recon below. Deployed
inert, this changes zero production behavior.

## The one thing I could not verify (why it's not wired)

The AllDay/TopShot flow this mirrors depends on DapperOffersV2 offers being
**EDITION-type**: `OfferAvailable.offerParamsString._type == "EDITION"`, carrying an
`editionId` that equals `editions.external_id`. The route filters to exactly those.

- **Confirmed:** Golazos DapperOffersV2 offers exist — 284 historical rows in
  `marketplace_offers`, `nft_type = A.87ca73a41bb50ad5.Golazos.NFT`. (That older,
  frozen table stored them by `nft_id`, which does **not** settle the on-chain
  `_type` question — AllDay rows in the same table are also `nft_id`-keyed, yet
  AllDay's live offers are EDITION-type.)
- **Not confirmed:** whether Golazos's *live* OffersV2 offers are EDITION-type vs
  NFT-type. This is an on-chain fact and the build sandbox has **no Flow REST
  egress** (`rest-mainnet.onflow.org` → 403 through the proxy) and no Cadence MCP,
  so it could not be read here.

## Recon + activation (needs prod / any env with Flow REST egress)

1. Deploy (ships inert). `POST https://www.rippackscity.com/api/golazos-offers-indexer`
   with `Authorization: Bearer $INGEST_SECRET_TOKEN`.
2. Read the JSON response:
   - **`offersSeen > 0`** → Golazos offers ARE EDITION-type and the mapping works.
     Verify `edition_offers` gained Golazos rows (`GET` the same route returns the
     count), spot-check 2–3 `golazos_open_offers.edition_id` values against
     `editions.external_id` (collection_id `06248cc4-…`), then **wire a cron**
     (cron-job.org, ~20 min, Bearer token — identical to `allday-offers-indexer`).
     Add it to `docs/operations/cron-schedule.md`.
   - **`offersSeen == 0`** while OfferAvailable volume exists → offers are NFT-type.
     **Do NOT wire the cron.** The NFT-type variant needs `nft_id -> edition`
     resolution (like sales; Golazos nft→edition mapping is itself partial), which
     is a separate build — file it, don't force this route.

## Downstream note

This route writes `edition_offers.highest_offer` (keyed `collection_id,
external_id`), which is what surfaces "Best offer" on edition/moment pages via
`get_edition_high_offer`. It does **not** write `badge_editions.highest_offer`
(TopShot fills that straight from GQL in `badge-sync`; there is no Golazos
badge-sync). If the Golazos *badge board* also needs `highest_offer`, add a small
`edition_offers → badge_editions` copy step for Golazos after this indexer is live —
but that is secondary; the edition/moment "Best offer" cell is the primary surface.

## Revert

- `DROP TABLE public.golazos_open_offers;`
- `DELETE FROM public.event_cursor WHERE id='golazos_offers';`
- `git revert <sha>` removes the route.

## Honesty constraint

`edition_offers.highest_offer` is a **BID** signal (best standing offer), never FMV —
never fold it into `fmv_snapshots`. (Same rule as AllDay/Candy offers.)
