# AllDay Listing Divergence — Root Cause Audit

**Date:** 2026-05-11
**Pipeline:** `listing-divergence-snapshot`
**Status:** Investigation only — no fix landed. Three independent causes identified.

---

## Headline numbers (AllDay, snapshot taken 2026-05-11)

| Metric | Value |
|---|---|
| `total_flowty` (active) | 86 |
| `total_direct` (active) | 60 |
| `matched` | 4 |
| `flowty_only` | 82 |
| `direct_only` | 56 |
| `divergence_pct` | ~97% of the union is one-sided |

The "99%" framing in the original task is a slight overcount because divergence_pct in `compute_listing_divergence` is `(f_only + d_only) / (f_only + d_only + matched)`. With these numbers: `(82 + 56) / (82 + 56 + 4) = 97.2%`. Same conclusion regardless: the two sources are tracking almost-disjoint listing universes.

---

## Three independent causes

### Cause 1 — temporal window mismatch (dominant)

The `flowty` source is a **snapshot of the current active marketplace** as returned by `api2.flowty.io`. It has no notion of "when did our indexer start observing." Whatever is for sale *right now*, flowty sees.

The `direct` source is an **event-driven indexer** that walks `0x3cdbb3d569211ff3.NFTStorefrontV2.ListingAvailable` going forward. Per `app/api/allday-listings-indexer/route.ts`:

> First run initializes the cursor at the current sealed block height — no historical backscan.

So `direct` only contains listings whose `ListingAvailable` event fired **after the indexer's first cron tick**. Anything posted before that is invisible.

Concretely:

| Source | Oldest `listed_at` | Newest `listed_at` |
|---|---|---|
| `flowty` | 2025-11-23 13:42 | 2026-05-10 22:17 |
| `direct` | 2026-05-10 00:20 | 2026-05-11 02:14 |

The direct indexer started ~2026-05-09. Every listing in the 5.5-month gap is `flowty_only` by definition. That alone accounts for the majority of the 82 `flowty_only` rows.

### Cause 2 — edition-resolution skip in the direct indexer (secondary)

[allday-listings-indexer/route.ts:488-492](../../app/api/allday-listings-indexer/route.ts#L488-L492):

```ts
if (!editionUuid) {
  if (unresolvedSample.length < 20) unresolvedSample.push(a.nftID)
  rowsSkipped++
  continue
}
```

When `direct` processes a `ListingAvailable` event, it tries to resolve `nftID → editions.id` via two paths:

1. **`wallet_moments_cache` lookup** ([line 412](../../app/api/allday-listings-indexer/route.ts#L412)) — fast, but only works if the seller's wallet has been wmc-backfilled.
2. **Cadence borrow fallback** ([line 444](../../app/api/allday-listings-indexer/route.ts#L444)) — gated by `CADENCE_FALLBACK_MAX = 12` per tick.

Any nftID that fails both paths is **silently dropped** ([line 491](../../app/api/allday-listings-indexer/route.ts#L491)). It's logged in `pipeline_runs.extra.unresolved_sample` but never retried.

This explains a curious data shape we observed: a single seller's **batch listing** (8 NFTs with identical `listed_at` and identical `price`) is **partially captured** by `direct` and the rest are `flowty_only`. Specifically, LRIs `267181328187912 / …913 / …917 / …918` are matched (all four came from the same batch event), while `267181328187953 / …966 / …979 / …980` from the same batch are `flowty_only`. The Cadence fallback hit its 12-call cap mid-batch.

Supporting numbers from the active-rows snapshot:
- `direct.distinct_sellers = 10`
- `flowty.distinct_sellers = 21`

Direct sees roughly half as many sellers — consistent with the skip-on-failure pattern preferring sellers we already have in `wallet_moments_cache`.

### Cause 3 — currency conversion (silent price-mismatch inflator)

`compute_listing_divergence` includes a `price_mismatches` count via:

```sql
COUNT(*) FROM f INNER JOIN d USING (listing_resource_id)
  WHERE COALESCE(f.price_usd, -1) <> COALESCE(d.price_usd, -1)
```

But:

| Source | `currency = 'USD'` | `currency != 'USD'` |
|---|---|---|
| `direct` | 0 | 60 |
| `flowty` | 86 | 0 |

`direct` stores listings in their native vault currency (DUC, FUSD, FLOW, etc.) and only populates `price_usd` when `isUsdEquivalent(currency)` returns true — for non-USD currencies, `price_usd` is **NULL**. `flowty` returns pre-converted USD prices from its API.

Result: every matched listing will be flagged as a `price_mismatch` because `direct.price_usd` is NULL and `flowty.price_usd` is a real number. This is a measurement artifact, not a real disagreement. Today only 4 listings match overall so the impact is hidden; if we fix causes 1 + 2, `price_mismatches` would spike to 100% of matches.

---

## Resolution paths (ordered by leverage)

1. **Stop dropping unresolved listings in `direct`** (cause 2). Two options:
   - Persist unresolved nftIDs to a `pending_edition_resolution` table and run a chained resolver, the same pattern `allday-unmapped-resolver` uses for sales.
   - Allow rows to be inserted with `edition_id = NULL` and resolve in a background pass. This widens the divergence metric immediately but recovers the lost listings.
   - Raise `CADENCE_FALLBACK_MAX` past 12 and add retry-on-cron-tick. Simplest, but burns Flow access calls.

2. **Fix the price-mismatch artifact** (cause 3). Either:
   - Backfill `price_usd` on direct rows by reading the day's FX rate for the listing currency, OR
   - Change `compute_listing_divergence` to compare prices only when both sides have non-NULL `price_usd`, OR
   - Normalize at write time in the direct ingest by converting native price to USD via a known rate (DUC is 1:1, others need an oracle).

3. **Add a temporal-window overlap metric** (cause 1). The simplest framing: only count listings whose `listed_at >= GREATEST(min(direct.listed_at), min(flowty.listed_at))`. Track the *fair* divergence — what gets through after we've controlled for the indexer's observability gap. This is a metric change, not a code fix; the 5.5-month historical gap is a known feature of the direct indexer's "no backscan" design.

4. **(Optional) Backfill `direct` from spork history** — requires the `spork-proxy` Cloudflare Worker mentioned as "Known issue #7" in CLAUDE.md. Would close the temporal gap but is out of scope for this audit.

---

## Recommendation

**Don't take all three at once.** The temporal window (cause 1) is the dominant numerical contributor but is the deepest architectural change. Cause 2 is the cheapest fix and the most diagnostic — landing it tells us whether the per-batch capture parity is purely a resolver-rate issue. Cause 3 is a one-line change to the divergence metric.

Suggested order:
1. Land cause 3 (metric change) — instant truth in the divergence dashboard.
2. Land cause 2 (resolver) — confirm or refute the per-batch hypothesis.
3. Defer cause 1 until spork-proxy ships.

---

## Files touched during this audit (read-only)

- [app/api/listing-divergence-snapshot/route.ts](../../app/api/listing-divergence-snapshot/route.ts) — thin wrapper around `compute_listing_divergence` RPC.
- [app/api/allday-listings-indexer/route.ts](../../app/api/allday-listings-indexer/route.ts) — the `source='direct'` writer. Edition-resolution skip lives at lines 488-492.
- [app/api/sync-flowty-listings/route.ts](../../app/api/sync-flowty-listings/route.ts) — the `source='flowty'` writer. Did not deep-read but confirmed it's the only flowty path.

Supabase RPC: `compute_listing_divergence(p_collection_id, p_write_snapshot, p_notes)` — definition pulled via `pg_get_functiondef`. Join key is `listing_resource_id`.
