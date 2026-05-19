# Pack EV pipeline audit — 2026-05-19

Audit performed during the packs page cleanup session. Scope: trace why
`pack_ev_latest.primary_price` is NULL across all 5,178 rows in the catalog,
why Top Shot secondary_ask coverage is 5%, and why AllDay coverage is 0%.

## TL;DR

- **Top Shot pipeline only computes EV for packs with active secondary listings.** It writes 1-69 rows per day, matching the population of TS packs currently listed on the marketplace. The rest of the catalog (`pack_distributions`) never gets a `pack_ev_latest` row.
- **AllDay pipeline computes EV for every distribution but never writes any price columns.** All 1,200-1,800 daily writes have `primary_price = NULL`, `secondary_ask = NULL`, `price_source = NULL`. Of those, 86.7% have `pack_price = 0` (reward/quest packs) and get filtered out by the `pack_price > 0` constraint on `pack_ev_latest`.
- **`primary_price` is never populated for either collection.** This is structural, not transient — the column exists in the schema, the writer code references it, but no code path actually reads a primary retail price from upstream and writes it. The "primary" half of the dual-price model has never shipped.

## Data summary (snapshotted 2026-05-19)

### `pack_ev_latest` coverage

| Collection | Distributions | With EV | With `primary_price` | With `secondary_ask` | Most recent snapshot |
|---|---:|---:|---:|---:|---|
| NBA Top Shot | 1,902 | 651 (34%) | **0** | 100 (5%) | 2026-05-18 16:38 |
| NFL All Day | 3,052 | 487 (16%) | **0** | **0** | 2026-05-19 16:37 |
| LaLiga Golazos | 224 | 0 (0%) | 0 | 0 | NULL (cron never wrote) |

### `pack_ev_history` writes — last 7 days

| Day | NBA Top Shot | NFL All Day |
|---|---:|---:|
| 2026-05-19 | 0 | 1,252 |
| 2026-05-18 | 1 | 1,111 |
| 2026-05-17 | 0 | 1,759 |
| 2026-05-16 | 1 | 1,555 |
| 2026-05-15 | 4 | 1,710 |
| 2026-05-14 | 69 | 1,553 |
| 2026-05-13 | 8 | 1,396 |

The asymmetry is striking: AllDay writes ~1,500/day across the entire catalog; TS writes 0-69/day because the cron is gated on active secondary listings.

### TS history row shape (sample, 2026-05-15)

| dist_id | pack_name | pack_price | gross_ev | pack_ev | primary_price | secondary_ask | price_source |
|---|---|---:|---:|---:|---|---:|---|
| 8422 | Rookie Rumble: Chance Hit | 11.00 | 0.00 | 0.00 | NULL | 11 | secondary |
| 6899 | Superstars Collector's Pack | 410.00 | 733.73 | 323.73 | NULL | 410 | secondary |
| 473 | Lace 'Em Up (Series 1) | 2500.00 | 342.49 | -2157.51 | NULL | 2500 | secondary |
| 1743 | Base Set (S2 R11) | 7.00 | 7.21 | 0.21 | NULL | 7 | secondary |

Pattern: **`pack_price === secondary_ask` on every row.** The "anchor price" being used to compute `pack_ev = gross_ev - pack_price` IS the secondary ask. There's no actual dual-price decision being made — the cron just writes the secondary ask into both columns.

### AllDay history row shape (sample, 2026-05-19)

| dist_id | pack_name | pack_price | gross_ev | pack_ev | primary_price | secondary_ask | price_source |
|---|---|---:|---:|---:|---|---|---|
| 4522 | Rookie Revelation Crate | 0.00 | 3206.49 | 3206.49 | NULL | NULL | NULL |
| 4495 | Jayden Daniels Rookie Revelation - Reward | 0.00 | 1414.04 | 1414.04 | NULL | NULL | NULL |
| 4523 | Jayden Daniels Rookie Revelation - Jersey Serial | 0.00 | 1414.04 | 1414.04 | NULL | NULL | NULL |
| 4503 | Caleb Williams Rookie Revelation - Reward | 0.00 | 598.50 | 598.50 | NULL | NULL | NULL |

Pattern: **`pack_price = 0` for reward/quest/jersey-serial packs**, which is correct — they have no retail price. But `pack_ev_latest`'s `pack_price > 0` filter then drops all of these rows from the catalog, so the EV (which is actually useful — gross pull value for a free pack is genuinely informative) never reaches users. And every dual-price column is NULL.

## Root causes

### TS: pipeline is listings-gated, not catalog-gated

The TS EV writer in `app/api/pack-ev/route.ts` runs on demand for a specific `distId` and only fires when the route is called. The on-cron path appears to walk the active marketplace listings (via Dapper Studio's `searchPackNftAggregation`, same query the new `/api/pack-listings` uses), and for each LISTED pack, fetches the EV. Packs without an active listing never enter the loop, so they never get a `pack_ev_latest` row.

Consequence: the 1,902 TS distributions are mostly historical / sold-out / no-secondary-market — only ~100 are currently liquid, and only those have any EV data on the page. Everything else shows "—" for EV margin, which the user reasonably reads as "EV is wrong / missing."

### TS: `primary_price` write path doesn't exist

`/api/pack-ev` line ~810 writes `primary_price: dual.primaryPrice` to `pack_ev_history`, but `dual.primaryPrice` is computed in a code path that requires the Dapper Studio response to have BOTH a primary listing (from contract reserve, `owner = 0b2a3299cc857e29`) AND a secondary listing. The TS query in `/api/pack-listings` explicitly EXCLUDES contract-reserve listings (`owner_address: { ne: reserveOwner }`, `excludeReserved: { eq: true }`), so the primary side never has data. The `dual.priceSource` then defaults to `'secondary'` for every row.

To populate primary_price, the cron would need a SEPARATE query that DOESN'T exclude reserved owner, then keep the `min(price)` from reserve-owned listings. That's a 1-query addition, not a refactor.

### AllDay: pipeline isn't wired to the dual-price model at all

The AllDay EV cron (`/api/allday-pack-ev`, 708 lines) computes gross EV from `pack_drop_pool` + `editions` + FMV, but the INSERT into `pack_ev_history` writes NULL for every dual-price column. This isn't a bug in the writer — it's that the writer has no data source feeding it those values. For AllDay the cron would need to either:

1. Pull `retail_price_usd` from `pack_distributions.metadata` and write it as `primary_price`. (Easy; data is already there.)
2. Pull live secondary low ask from the now-collection-aware `/api/pack-listings?collection=nfl-all-day` (added in Phase 4 of the packs page cleanup). (Requires verifying Dapper Studio actually returns AllDay PackNFT data — assumption, not confirmed.)
3. Set `price_source` based on which prices populated.

### AllDay: $0 reward packs hidden by `pack_price > 0` filter

The `pack_ev_latest` view filters `WHERE pack_price > 0`. AllDay's reward / quest / jersey-serial packs have legitimate $0 retail (you don't buy them with money), so they're hidden. But their gross_ev is sometimes substantial ($3,206 for the Rookie Revelation Crate sample) and the "no-cost EV" is actually genuinely useful to users planning their quest completions.

Either relax the filter, or add a `is_no_cost_pack` flag and let the UI surface a "Reward packs" subsection.

### Golazos: cron never wrote (scope-removed)

`compute-laliga-pack-ev` route exists at `app/api/cron/compute-laliga-pack-ev/route.ts` but `pack_ev_latest` has 0 Golazos rows. Either the cron isn't scheduled, or it's scheduled and failing silently. Out of scope for this audit — Golazos packs surface was removed entirely in Phase 1 of this session.

## Recommended fixes (in priority order)

### P0 — Wire AllDay dual-price columns (fastest user-visible win)

In `/api/allday-pack-ev`, where each `pack_ev_history` row is INSERTed:
1. Read `pack_distributions.metadata->>'retail_price_usd'` for the distribution. If present and > 0, write it to `primary_price` and set `primary_available = true`.
2. Optionally: fetch secondary low ask from `/api/pack-listings?collection=nfl-all-day` (introduced 2026-05-19) and write to `secondary_ask`. Set `secondary_available = true` if found.
3. Compute `price_source`:
   - Both → `'min'` if min(primary, secondary) is genuinely lower than the other; otherwise the cheaper side
   - Primary only → `'primary'`
   - Secondary only → `'secondary'`
   - Neither → `'none'`
4. Set `pack_price` to whichever side is the EV anchor — currently it's 0 for the reward packs, which is mathematically correct for "free pack EV" but the view filter then drops the row. Either relax the view filter or distinguish reward packs at the writer.

### P1 — Wire TS `primary_price`

In `/api/pack-ev`, add a second Dapper Studio query that DOESN'T exclude reserved owner. The PACK_LISTINGS_QUERY structure is reusable — just swap the filter to `owner_address: { eq: cfg.reserveOwner }, excludeReserved: { eq: false }`. Take `min(listing.price.min)` across that set and write to `primary_price`. Recompute `price_source` accordingly.

This is a 50-line addition to `/api/pack-ev` and would immediately populate `primary_price` for the ~100 TS distributions that currently get any EV at all.

### P2 — Expand TS coverage from listings-gated to catalog-gated

Refactor `/api/pack-ev` so the cron walks `pack_distributions` (1,902 rows) instead of walking active listings (100 rows). For each distribution:
1. Compute gross_ev from `pack_drop_pool` + FMV (same as current).
2. Query primary listings from Dapper Studio (per P1).
3. Query secondary listings from Dapper Studio (current path).
4. Write a row to `pack_ev_history` regardless of whether listings exist — `price_source = 'none'` is a valid state and the UI can still render gross_ev.

This expands TS coverage from 34% (651/1902) toward 100%. Significant compute lift — should be batched and run nightly, not every-tick.

### P3 — Reconsider the `pack_price > 0` view filter

Either:
- Drop the filter — let reward packs into `pack_ev_latest` with `pack_price = 0`. The UI's existing DualPriceCell handles NULL prices, so $0 displays as $0 (correct).
- Add a sentinel column `pack_kind` ∈ {paid, reward, quest, bundle} and let the UI segment.

Either is a 1-migration change.

### P4 — Diagnose Golazos cron

Out of scope for the packs page cleanup since the surface was removed. When Golazos packs are reintroduced, check:
- Cron-job.org schedule status for `compute-laliga-pack-ev`
- Whether the route handler authenticates correctly (Bearer `INGEST_SECRET_TOKEN`)
- Whether the Golazos PackNFT type / Dapper Studio query returns data

## Cross-reference

- `pack_table_rows` view (catalog): `pack_distributions pd LEFT JOIN pack_ev_latest pev` — explains why unEV-computed packs appear in the table with NULL EV columns.
- `pack_ev_latest` view: `SELECT DISTINCT ON (pack_listing_id) ... WHERE pack_ev BETWEEN -10000 AND 1000000 AND pack_price > 0 AND pack_name NOT LIKE 'Holding %'` — the filter dropping 86.7% of AllDay history rows.
- `/api/pack-listings/route.ts` (extended 2026-05-19): now `?collection=nba-top-shot|nfl-all-day` parametrized via `COLLECTION_CONFIG`. P0 and P1 can both consume this for live ask data.
- `/api/pack-ev/route.ts`: the cron writer. Pack EV history INSERT around line 806.

## Methodology note

Queries used for this audit are in this session's chat history under the timestamps 2026-05-19. The key sample queries:
1. `pack_table_rows` coverage by collection — GROUP BY collection on the view.
2. `pack_ev_history` writes by day — last 7 days bucketed.
3. Sample 5 rows of each collection's recent history to see the actual column values.
4. AllDay distinct `pack_listing_id` with `pack_price > 0` ratio.
