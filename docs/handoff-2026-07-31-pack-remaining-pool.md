# Handoff — Pack "remaining pull pool" accuracy

Author: Cowork, 2026-07-31 (PT). Trigger: Trevor — *"We want an accurate view of what's left to be pulled from every single pack, so we can accurately provide Pack EV to our users."*

Two DB-only items already SHIPPED (see `docs/overnight/ledger.md`, 2026-07-31). Everything below needs repo/worker/edge access Cowork does not have, or is a product decision.

## The one-paragraph summary

The remaining-pull pool comes from the **publisher** (`packEditionsV3 { count remaining }` + `packListingContentRemaining`), **not** from our on-chain pack-open history. Only Top Shot models remaining at all; AllDay, Golazos and Pinnacle all weight by original minted supply, which systematically overstates EV on picked-over packs. Of **1,398** distributions currently serving a live Pack EV, only **390 (27.9%)** have a remaining pool we can defend.

Query the state any time:

```sql
SELECT collection, remaining_basis, remaining_trustworthy, count(*) AS dists,
       sum(total_sealed) AS packs_still_sealed, min(basis_note) AS note
  FROM public.v_pack_remaining_basis
 GROUP BY 1,2,3 ORDER BY 1, 4 DESC;
```

## Item 1 — AllDay Pack EV is original-supply weighted (HIGHEST user-facing impact)

`supabase/functions/compute-allday-pack-ev/index.ts` (v9) weights each edition by `circulation_count` via `supplyWeightPool()` and **never queries `remaining`**. Because `drop_weight == orig_drop_weight` and the collection isn't Top Shot, `compute_pack_ev_per_edition_weighted` resolves `ev_basis='original'` for all 2,950 AllDay dists.

Meanwhile `app/api/allday-pack-ev/route.ts:454` already does the right thing at request time:

```ts
const prob = totalUnopened > 0 ? node.remaining / totalUnopened : 0
```

**So there are two different EV models on the same collection**, and the warehouse one (which feeds the boards) is the pessimistic-for-accuracy one. Measured bias on real consumer packs:

| dist | pack | price | gross_ev | typical_ev | realized median | n_opens |
|---|---|---|---|---|---|---|
| 7073 | Grail Seekers: Legendary | $299 | **$523** | $18.90 | **$65.63** | 124 |
| 7103 | Grail Seekers: Legendary | $299 | **$386** | $14.00 | **$73.62** | 125 |

**Fix:** port the `packEditionsV3 { count remaining }` pagination from the API route into `compute-allday-pack-ev`, write `drop_weight = remaining / totalUnopened` and keep `orig_drop_weight = count`. That single change flips AllDay to `ev_basis='remaining'` automatically — the RPC already picks basis off `orig_drop_weight` presence, so **check that interaction**: today AllDay writes `orig_drop_weight = w` (the same normalized weight), which is what forces `'original'`. This is pricing logic, so it wants a human review + a before/after diff against `v_allday_pack_realized_ev`.

**Revert:** `git revert <sha>` + redeploy the previous edge function version.

## Item 2 — Internal Dapper reserve packs are being published with absurd EV

`pack_ev_latest` includes non-purchasable internal distributions:

| dist | title | pack_price | gross_ev |
|---|---|---|---|
| 5730 | NFL Pack Hold - Genesis | **$999,999** | **$900,000** |
| 7186 | Super Bowl LX: Holding Pack | $9,999 | $3,767 |
| 7135 | Playoff Icons: Premium Serial | $9,999 | $2,450 |
| 6373 | Legends of The Turf: Premium S | $9,999 | $2,025 |
| 6722 | Ultimate Holding Pack (Rookie) | $9,999 | $900 |

These alone pull AllDay's average `gross_ev` to **$1,880** against a `typical_ev` of **$14.18**. They are reserve/holding rows, never sold to users.

**Fix:** exclude them from the publish path. A price sentinel (`pack_price >= 9999`) plus a title filter (`title ILIKE '%holding%'` / `'%pack hold%'`) covers all observed cases, but confirm against the full list before hardcoding — this is a publish-guard change, and per the "an MV is NOT the view it mirrors" rule the guard must live in every surface that publishes EV, not just one.

**Revert:** `git revert <sha>`.

## Item 3 — The moments-hydrator backlog is unreachable by construction

This is the fix for the 174,018-pull Top Shot attribution gap. **It is not a throughput problem.**

`v_moments_needing_hydration` (live definition):

```sql
SELECT nft_id, collection_id, wallet AS owner_address, acquired_date, source_pack_rip_id
  FROM moment_acquisitions ma
 WHERE acquisition_method = 'pack_pull'
   AND acquisition_confidence = 'verified'
   AND NOT (EXISTS (SELECT 1 FROM moments m
                     WHERE m.nft_id::text = ma.nft_id AND m.collection_id = ma.collection_id));
```

There is **no attempt counter, no failure flag, no last-tried timestamp** — anywhere. `workers/topshot-moments-hydrator/index.ts:118` reads it `ORDER BY acquired_date DESC LIMIT 300`. A moment leaves the view only by acquiring a `moments` row, so every nft_id GraphQL cannot resolve sits at its ordinal position **forever** and is re-fetched every 10 minutes. Observed: the top-300 window spans ~3.5 days, ~30–90 dead rows accumulate per day, and **~173,500 rows older than that (Apr–May 2026) are never fetched at all.**

**Fix:** add `hydration_attempts int` + `last_hydration_attempt_at timestamptz` to `moment_acquisitions` (or a side table keyed on nft_id), have the worker increment on every attempt, and order candidates by `last_hydration_attempt_at NULLS FIRST` so the queue rotates. Optionally retire a moment after N failed attempts. Needs the worker change **and** a wrangler deploy (Cowork has no `CLOUDFLARE_API_TOKEN`).

**Note on priority:** this gap does **not** affect Top Shot's remaining pool (which comes from the publisher). It affects pull provenance and realized-EV calibration — `v_topshot_pack_realized_ev`. Worth fixing, but it is not the Pack EV accuracy blocker Trevor may assume.

**Revert:** `git revert <sha>` + redeploy prior worker version.

## Item 4 — 324 Top Shot dists have an incomplete pool but still serve EV

`v_pack_remaining_basis` flags 324 TS dists as `pool incomplete (sum drop_weight < 0.5)` covering **284,996 sealed packs** — more sealed packs than the trustworthy set. The DB guard `compute_pack_ev_per_edition_weighted` returns `ok:false, reason:'pool_incomplete'` for these, yet **312 of them still carry a live `pack_ev_latest` row** (avg `gross_ev` $47.79). Worth confirming whether those rows are stale survivors from before the guard landed, or whether the publish path ignores the guard.

**Fix:** decide whether an incomplete pool should suppress the EV row entirely (consistent with the `depleted` / `placeholder_uniform` cases, which correctly show null) or surface with a caveat.

## Item 5 — Operator / smaller

- **Atlas pool stale since 2026-07-17** — 57 TS dists, EV still recomputes off it hourly. Needs the Atlas env var + a fresh Bearer (already tracked in memory as the "Atlas key" item, 229 targets waiting).
- **`gql_historical` mislabel (544 dists)** — `backfill-topshot-pack-supply` `mode=pool` writes `drop_weight = count / totalCount` (original mint share) but the RPC reports `ev_basis='remaining'`. Currently latent (0 live EV rows, `pack_ev_latest` filters `pack_price > 0`) — fix before any of those dists gets a price.
- **`topshot-pack-opens-history-backfill` is doing nothing** — 193 runs/48h at block ~95.5M, re-walking ground already covered (268k TS rips sit below it), **0 new rips in 5 days**. Its `extra` payload omits `rips_written` entirely so it looks productive. Either give it a stop condition or point it at a genuine gap.
- **Pinnacle has no pack-open ingest at all** (0 rips vs 433,575 publisher-opened) and no drop-pool rows; its EV is inline supply-weighted off `pinnacle_catalog.total_minted`.

## What is NOT worth doing

- **Do not build an opens-derived remaining pool for Top Shot.** Our TS rip history covers 4.5% of publisher-reported opens (762,082 / 16,837,027) because it starts 2023-09-29 and TS packs start 2020. Publisher remaining is the only honest TS source.
- **Do not re-run the sales-vs-wmc attribution audit without collection-scoping.** Joining `sales` on `nft_id` alone matches across collections and manufactures a fake ~13% error rate. Scoped, all sources agree 100%.
