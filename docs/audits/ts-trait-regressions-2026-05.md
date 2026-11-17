# TopShot trait-regression unified writeup — 2026-05-10

Round 6 raised the question whether the two open-ish TopShot trait regressions are the same underlying bug
surfaced in two ingest paths, or two separate bugs. After reading both code paths and the live data:

**They are two separate bugs with two different root causes and two different fixes. Both are now closed.**

| Regression | Surface | Root cause | Status |
|---|---|---|---|
| Sales `serial_number = 0` | `app/api/sales-indexer/route.ts` (Vercel route) | GQL projection missing the `flowSerialNumber` field — local code bug | Fixed in [`55566e3`](https://github.com/jamesdillonbond/rip-packs-city/commit/55566e3) 2026-05-05; residue 2,471 rows recovered in [`f6bed25`](https://github.com/jamesdillonbond/rip-packs-city/commit/f6bed25) 2026-05-10. CLOSED. |
| Listings `set_id = play_id = 0` | `scripts/ts-ingest.js` (GitHub Actions `ts-listing-ingest.yml`, every 5min) | Flowty API stopped emitting `SetID` / `PlayID` traits — external upstream contract change | Fixed in-script via `fetchTopShotEditionsLookup` editions-table fallback + explicit skip-on-unresolved guard. Verified closed below. CLOSED. |

The window overlap is coincidence. The symptom shape (zero-valued integers) is similar because both ingest
paths default integer fields to 0 when their normal source goes silent, but the silent sources are completely
disjoint:

- Sales: a field that exists in the GraphQL response was never asked for in the projection.
- Listings: a field that the trait extractor *was* asking for stopped being returned by the upstream service.

## Sales regression (recap from ts-trait-regression-rootcause.md)

Full details in [`docs/audits/ts-trait-regression-rootcause.md`](./ts-trait-regression-rootcause.md). Summary:

- Window: 2026-04-10 → 2026-05-05.
- Three resolution paths fed `serial_number`. Path 1 (wmc cache hit) worked. Paths 2 (`moments` table) and 3
  (GQL fallback) both omitted the field from their SELECT/projection.
- Fix in `55566e3`: GQL projection now requests `flowSerialNumber`; row builder threads
  `{ editionId, serial }` through `momentsMap` and `gqlResolvedMap`; only zero-coerces at insert time so the
  pipeline counters (`serials_resolved` + `serials_zero` in `pipeline_runs.extra`) can distinguish a real zero
  from a missing resolution.
- Recovery in `f6bed25`: `scripts/backfill-ts-serial-zero-sales.mjs` walked the regression window via
  `getMintedMoment(momentId)` and UPDATE'd serial back onto the rows. Unrecoverable cases logged into
  `pipeline_runs.extra.unrecoverable_nft_ids`.

Today: 0 new TS serial=0 rows since 2026-05-06.

## Listings regression — current state of `scripts/ts-ingest.js`

The framing in memory line 8 (and in CLAUDE.md Known Issues item 11-style language) is **stale**. It calls
the listings issue OPEN with the symptom "name-fallback resolver papers over zero-traited rows." The actual
code today is different and closes the issue without ever silently emitting zero rows.

### What the code does now

`scripts/ts-ingest.js` (ts-listing-ingest.yml, every 5min):

1. Try Flowty NFT traits for `SetID` + `PlayID` (`getTraitMulti(traits, TRAIT_MAP.setID/.playID)`). If both
   resolve to positive integers, use them. Counter: `trait_resolved`.
2. If the trait path returned zero/missing, fall through to `fetchTopShotEditionsLookup` — a single SELECT
   against `editions WHERE collection_id=nba_top_shot AND set_id_onchain IS NOT NULL AND
   play_id_onchain IS NOT NULL`, keyed by `lower(player_name) | lower(set_name) | series`. ~92% of NBA TS
   editions (9,214 of 9,991) have the on-chain ID columns populated. Counter: `lookup_resolved`.
3. If **neither** path resolves, the row is **explicitly skipped** (`continue`), with a console.warn for the
   first three skips and a counter in `pipeline_runs.extra.skipped_no_ids`. The row never reaches the upsert,
   so `ts_listings` never grows a `set_id=0` row from the live pipeline.

### Verification against live data

Snapshot taken 2026-05-11 04:18 UTC:

| Metric | Count |
|---|---|
| `total_rows` in `ts_listings` | 106 |
| `set_id = 0` rows | 0 |
| `play_id = 0` rows | 0 |
| `both zero` rows | 0 |

Last 5 `ts-listing-ingest` pipeline_runs:

| started_at | ok | rows_found | rows_written | trait_resolved | lookup_resolved | skipped_no_ids |
|---|---:|---:|---:|---:|---:|---:|
| 2026-05-11 04:18 | true | 108 | 106 | **0** | **108** | 12 |
| 2026-05-10 23:06 | true | 114 | 112 | 0 | 114 | 6 |
| 2026-05-10 22:08 | true | 120 | 120 | 0 | 120 | 0 |
| 2026-05-10 21:24 | true | 115 | 115 | 0 | 115 | 5 |
| 2026-05-10 20:29 | true | 115 | 115 | 0 | 115 | 5 |

Notes:

- **`trait_resolved = 0` on every tick** — Flowty has not restored `SetID`/`PlayID` traits. The upstream
  regression that started this is still in place; the editions-lookup fallback is doing 100% of the work.
- **`lookup_resolved` ≈ `rows_found`** every tick — the fallback covers essentially every row Flowty
  returns.
- **`skipped_no_ids`** is the small residual (0–12 / tick) where neither path resolves. These are
  typically newly-minted editions that haven't been hydrated into the `editions` table yet, or non-standard
  `(player, set, series)` tuples. They produce no `ts_listings` row at all — the pipeline does not silently
  emit zero-traited rows.

### Memory line 8 update needed

Memory says: *"ts-listing-ingest pipeline emits zero-traited rows that the name-fallback resolver papers over."*
That's no longer accurate. The current behavior is:

> ts-listing-ingest does NOT emit zero-traited rows. When Flowty's trait-path resolution fails (which has
> been every row every tick since at least 2026-05-09), the editions-lookup fallback resolves the row
> against `editions.{set_id_onchain, play_id_onchain}` by `(player_name, set_name, series)`. If neither
> path resolves, the row is explicitly skipped (`continue`) and counted in
> `pipeline_runs.extra.skipped_no_ids` — it never reaches the upsert.

Action: update memory line 8 / `feedback_ts_listings_zero_trait.md` if it exists, to reflect closed status.

## Are these the same bug?

**No.** Side-by-side:

| | Sales | Listings |
|---|---|---|
| Ingest path | Vercel route `app/api/sales-indexer/route.ts` | GH Actions `scripts/ts-ingest.js` |
| Trigger | local code bug — GQL projection omitted `flowSerialNumber` | external upstream change — Flowty stopped emitting `SetID`/`PlayID` traits |
| Default-zero source | `serial_number` defaulted to 0 when GQL fallback fired | `setId`/`playId` initialized to `parseInt(undefined) \|\| 0` because trait keys returned `null` |
| Fix shape | Add the missing field to the GQL projection; thread serial through resolution map | Add a fallback resolution path (editions-table lookup); skip-on-unresolved guard |
| Recovery shape | Backfill script walks the regression window calling `getMintedMoment` to recover serial | No recovery needed — current code does not emit broken rows |
| Status today | CLOSED (fix 55566e3, recovery f6bed25) | CLOSED (fix in scripts/ts-ingest.js, no commit-named "trait fix" — landed as part of `fetchTopShotEditionsLookup` introduction) |

They share a symptom-shape only. Different ingest paths, different layers, different upstreams, different
fix shapes. The fact that they both showed up around the same time is the most interesting overlap, and is
most likely explained by a broader upstream Top Shot / Flowty ecosystem reshuffling in early April —
multiple consumers downstream all felt different facets of it.

## Open items

- **Memory line 8 / feedback file** (if present): update text per the box above. ts_listings trait
  regression is no longer open.
- **Defense-in-depth**: a CHECK constraint on `ts_listings` like
  `CHECK (set_id > 0 AND play_id > 0)` would make a future regression of this shape impossible to silently
  ingest. Not landing in this commit because the explicit skip-on-unresolved code is already doing the same
  job; the CHECK would catch a `set_id=0` row only if the application code's guard were itself bypassed.
  Worth proposing as a hardening pass.
- **Watchful counter**: `pipeline_runs.extra.skipped_no_ids` should be ~0–15. A spike past 50/tick would
  mean either (a) the editions hydrator is behind, or (b) Flowty changed *another* trait shape and the
  `(player, set, series)` tuple keys are no longer matching. Worth wiring into the existing pipeline-sentinel
  alerting if it isn't already.
