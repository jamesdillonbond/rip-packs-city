# Top Shot Marketplace Feed — Design Spec

**Date:** 2026-05-23
**Author:** Claude (Cowork session)
**Status:** Design — not yet built. Needs review + greenlight.
**Goal:** Replace the dead Flowty-based Top Shot listings pipelines with a marketplace-GQL feed that (1) restores Top Shot ask data and (2) prices the ~10,800 Top Shot `NO_DATA` editions — the "primary data" lever from `docs/audits/fmv-confidence-improvement-2026-05.md`.

---

## 1. Why

All four existing Top Shot listing pipelines are dead (see the 2026-05-23 session in `CLAUDE.md`):

- `topshot-listing-cache`, `topshot-listing-cache-v2` (`/api/listing-cache`), `ts-listing-ingest` (`scripts/ts-ingest.js`) — all fetch from **Flowty**, whose marketplace shut down ~2026-05-13. They run green and write 0 rows.
- `topshot-listings-indexer` — scans the on-chain NFTStorefront, but Top Shot *moments* aren't listed there in volume (only packs). Structural dead-end.

Consequence: `cached_listings_v2` has 0 Top Shot rows, the Market/Sniper Top Shot surfaces are empty, and FMV has no ask data for Top Shot — so 10,800 editions sit `NO_DATA` while the equivalent AllDay number is only 531 (because `allday-gql-v1` *does* pull asks). This feed closes that gap.

## 2. The proven query

`lib/topshot-graphql.ts` already contains a working, batched query — `SEARCH_EDITIONS_QUERY`. Per edition it returns exactly what we need:

```graphql
query SearchEditions($setID: ID, $playID: ID, $first: Int!) {
  searchEditions(input: { setID: $setID, playID: $playID, first: $first }) {
    data {
      set { id }
      play { id }
      stats { lowestAsk averagePrice totalSales }
      setPlay { circulationCount }
    }
  }
}
```

`stats.lowestAsk` is the live lowest ask; `stats.averagePrice` / `totalSales` are marketplace sale stats. This is the direct analog of AllDay's `searchMarketplaceEditions` (`lowestPrice` / `averageSale` / `totalListings`) that `allday-fmv-populate` already sweeps. One call per set returns every play in that set (`first: 250`).

**Add one field:** the query as written selects `set.id` + `play.id` but not the edition's own id — request `id` (or `editionID`) on the edition node so results match `editions.external_id` directly (see §6).

## 3. Architecture — mirror `allday-fmv-populate`

Copy the proven shape of `app/api/allday-fmv-populate/route.ts`:

- New route **`app/api/topshot-fmv-populate/route.ts`**.
- A cursor row in `backfill_state` (id `topshot-fmv-sweep`) — Top Shot is swept **by set**, so the cursor is a set-list index, not a GQL pageInfo cursor. Persist the ordered set list + position.
- Each run: process N sets per invocation (size for the ~25s budget), one `searchEditions` call per set, upsert results, advance the cursor, wrap to 0 at the end.
- Reuse the stall-detection + concurrency-lock pattern already in `allday-fmv-populate`.
- **Route all calls through the `topshot-proxy` worker** (`POST /topshot` → `public-api.nbatopshot.com/graphql`). `public-api.nbatopshot.com` is Cloudflare-blocked for Vercel/Supabase egress — never call it directly server-side, even though `lib/topshot-graphql.ts` currently does (that lib is a separate cleanup item).

## 4. The write RPC — `upsert_topshot_marketplace_fmv`

Mirror `upsert_allday_marketplace_fmv` (read its source first). Per edition:

1. Resolve the edition (see §6). Skip if no match.
2. **Skip if the edition's latest snapshot is `HIGH` or `MEDIUM`** — never clobber sales-based FMV from `fmv-recalc`.
3. Then:
   - `averagePrice > 0 && totalSales > 0` → `confidence = LOW`, `fmv_usd = averagePrice` (sale-backed).
   - else `lowestAsk > 0 && lowestAsk <= ASK_CEILING` → `confidence = ASK_ONLY`, `fmv_usd = lowestAsk`.
   - else → skip (genuinely no data; stays `NO_DATA`).
4. `algo_version = 'topshot-gql-v1'`. Delete-then-insert today's row (the partition-safe pattern; never upsert).

`ASK_CEILING`: AllDay uses $5,000. Top Shot has legitimate five-figure moments, so set it higher (e.g. $25,000) or tier-scale it — decide during build.

## 5. Confidence interaction

This feed only ever writes `LOW` / `ASK_ONLY`, and only for editions not already `HIGH`/`MEDIUM`. It is strictly additive — it cannot degrade the serial-residual HIGH work shipped 2026-05-23. The thin-sale haircut cron already targets `LOW` + `ASK_ONLY`, so ask-derived values get discounted downstream automatically.

## 6. The hard part — edition matching

This is the one genuine unknown and must be verified before building. `searchEditions` returns Top Shot's GraphQL UUIDs for `set` and `play`. Our `editions` table keys Top Shot rows by `external_id` (edition UUID), plus `set_id_onchain` / `play_id_onchain` (UInt32 integers) and a `set_id` FK.

Recommended path: add `id` to the `searchEditions` edition node so each result carries its **edition UUID**, then match `editions.external_id` directly — a clean 1:1 join, no set/play resolution needed. Verify against the live schema (via the Cadence/GQL tooling or a `topshot-proxy` probe) that the edition node exposes `id`. Fallback: match on `(set UUID, play UUID)` via the `sets` table — messier, confirm the join exists.

Editions returned by the API with no `editions` row are new editions — log a counter (`no_edition`) like `allday-fmv-populate` does; the catalog backfill handles seeding them.

## 7. Cron & scope

- New cron-job.org entry hitting `/api/topshot-fmv-populate` every 20 min (or chain it off `topshot-sales-indexer`). Add a `pipeline_cadence_watchlist` row.
- Full Top Shot catalog ≈ a few hundred sets; at a few sets per run it sweeps in well under a day.
- Exclude `ULTIMATE` editions (owned by `recalc_ultimate_fmv`) — same guard `allday-fmv-populate` already applies.

## 8. Phasing

- **Phase 1 (this spec) — edition-level FMV.** `searchEditions.stats` gives per-*edition* ask/sale stats, which is exactly what FMV needs. This is the high-value 80%: it prices the unpriced Top Shot tail. Ship this first.
- **Phase 2 (separate) — per-listing Market/Sniper surface.** `searchEditions` does not return individual moment listings, so it cannot repopulate a per-moment Market tab. That needs a listings-level query (a `searchMoments`/marketplace-listings call) writing `cached_listings_v2` with `collection_id` = Top Shot. Scope separately once Phase 1 is live.

## 9. Risks / open questions

- **Schema drift** — confirm `searchEditions` still returns `stats.lowestAsk` and that the edition node exposes `id`. The `lib/topshot-graphql.ts` header comment is already stale (it names the wrong endpoint), so treat that file as untrusted documentation — verify live.
- **Rate limits** — one call per set through `topshot-proxy`; keep the existing ~200 ms inter-call delay.
- **`lowestAsk` is an upper bound** — an ask is not a sale. `ASK_ONLY` confidence already signals this, and the haircut discounts it; do not promote ask-derived values above `ASK_ONLY`.
- This work also retires three dead pipelines — fold the Flowty-based `topshot-listing-cache*` / `ts-listing-ingest` removal into `docs/audits/flowty-teardown-plan-2026-05.md` Phase 2.

## 10. Definition of done (Phase 1)

`topshot-fmv-populate` runs on cron, sweeps all Top Shot sets, and writes `topshot-gql-v1` snapshots. Verify: Top Shot `NO_DATA` count drops materially from ~10,800 (toward the AllDay-equivalent residual), `ASK_ONLY` + `LOW` rise, and no `HIGH`/`MEDIUM` edition is overwritten.
