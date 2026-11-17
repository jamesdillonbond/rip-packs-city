# UFC sniper-feed investigation — 2026-05-04

## Reported symptom

`GET /api/sniper-feed?collection=ufc-strike` on production returns
`{"count":0,"tsCount":0,"flowtyCount":0,"deals":[]}`. UFC Strike has 24
freshly cached `cached_listings` rows in Supabase, so an empty feed felt
wrong.

## Findings

The UFC sniper page does **not** use `/api/sniper-feed` at all.
[app/(collections)/[collection]/sniper/page.tsx#L548-L554](../app/(collections)/[collection]/sniper/page.tsx#L548-L554)
maps each collection to its own endpoint:

| Slug              | Sniper endpoint               | Data source               |
| ----------------- | ----------------------------- | ------------------------- |
| `nba-top-shot`    | `/api/sniper-feed`            | TS cache + Flowty live    |
| `nfl-all-day`     | `/api/sniper-feed`            | All Day GQL + cache       |
| `laliga-golazos`  | `/api/golazos-sniper-feed`    | `cached_listings`         |
| `ufc`             | `/api/ufc-sniper-feed`        | Flowty live (4 pages)     |
| `disney-pinnacle` | `/api/pinnacle-sniper`        | Pinnacle router           |

So when the page renders `/ufc/sniper`, it hits `/api/ufc-sniper-feed`,
which pulls live from `https://api2.flowty.io/collection/0x329feb3ab062d289/UFC_NFT`
each request.

### The four investigation questions

1. **What `minDiscount` threshold does the UFC path use?**
   [app/api/ufc-sniper-feed/route.ts:71](../app/api/ufc-sniper-feed/route.ts#L71)
   defaults to `0`. The page does not pass a value when the user hasn't
   set one, so the API returns every Flowty NFT regardless of discount.
   The page-side relative-deals fallback at
   [page.tsx:821](../app/(collections)/[collection]/sniper/page.tsx#L821)
   hardcodes `minDiscount=10` only when `data.deals.length === 0`.

2. **Does the tier-median fallback fire when Flowty returns empty?**
   Only client-side. The page useEffect at
   [page.tsx:809-836](../app/(collections)/[collection]/sniper/page.tsx#L809-L836)
   triggers `/api/relative-deals` and `/api/tier-pricing-benchmarks` when
   `data.deals.length === 0` for `isUfc || isGolazos`. There is **no**
   API-side fallback inside `/api/ufc-sniper-feed` itself; if Flowty
   returns 0 NFTs, the API returns `count:0` and the page does the
   second roundtrip.

3. **Are 24 actual listings reachable, or is the cache stale?**
   The cache is fresh — `cached_at = 2026-05-04 00:00:39+00` (today),
   `listed_at` between 2026-02-01 and 2026-05-01. All 24 rows have
   `ask_price` between $0.40 and $0.50 (CONTENDER tier sub-dollar dust).
   `get_relative_deals` against that cache returns 2 deals at 20% off
   tier-median ($0.40 vs median $0.50).

4. **What does `collection=ufc-strike` resolve to internally?**
   It resolved to nothing. Three slug variants are in play:
   - `ufc` — canonical app slug (`lib/collections.ts` registry)
   - `ufc_strike` — DB slug (`collections.slug` column)
   - `ufc-strike` — neither; intuitive variant some callers reach for
   The old `resolveCollectionUuid` only had `nba-top-shot` and
   `nfl-all-day` hard-coded, so every UFC variant fell through to
   `return null` and short-circuited `computeCachedSniperFeed` to an
   empty response. Same bug silently hid Golazos and Pinnacle from the
   generic endpoint.

## Fix

Replaced the hard-coded `COLLECTION_UUID_MAP` with the registry helpers
[`getCollectionUuid` and `fromDbSlug`](../lib/collections.ts) so every
published Flow collection resolves, plus DB-slug tolerance so
`ufc-strike` and `ufc_strike` both fall back to `ufc`.
[app/api/sniper-feed/route.ts:1126-1139](../app/api/sniper-feed/route.ts#L1126-L1139)

After the fix, `GET /api/sniper-feed?collection=ufc` (and any of the
slug variants) returns the 24 cached UFC listings. They render with
`discount=0` / `confidence=ASK_ONLY` because UFC has no real FMV — that
is the expected post-condition for a thin-volume BETA collection. The
page-side tier-median fallback now no longer fires for UFC via this
endpoint because the deals array is non-empty; if you want tier-median
ranking, hit `/api/relative-deals?collection=ufc&minDiscount=10`
directly.

## What was NOT done

- The `/api/ufc-sniper-feed` route was left alone. It still pulls live
  from Flowty without an API-level fallback to `cached_listings`. If
  Flowty rate-limits or 5xxs across all four pages, the UFC sniper page
  goes empty and relies on the client-side relative-deals fallback. A
  follow-up would be to read `cached_listings` when Flowty returns 0,
  but the user's reported symptom was about the generic
  `/api/sniper-feed` endpoint, not the UFC-specific one.
- API-level tier-median enrichment for ASK_ONLY collections was not
  added — the page already handles it. Doing it server-side would mean
  every cached-collection caller pays for an extra RPC even when they
  have non-zero discounts to show.
