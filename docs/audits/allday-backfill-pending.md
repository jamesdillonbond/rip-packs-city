# AllDay historical backfill — pending Trevor's run

**Status as of 2026-05-11 15:42 UTC:** the full `scripts/backfill-allday-listings-historical.mjs` run has not yet been executed.

Two `allday-listings-historical-backfill` rows exist in `pipeline_runs` from 14:18 UTC on 2026-05-11, both narrow test slices:

| started_at | floor_block | ceiling_block | blocks_scanned | events_resolved | duration_ms |
|---|---|---|---|---|---|
| 14:18:26 | 151,000,000 | 151,023,092 | 23,092 | 36 | 29.5s |
| 14:18:12 | 151,022,000 | 151,023,092 | 1,092 | 0 | 1.8s |

Both runs cover only ~23K blocks each. The script's intended default floor is 2025-11-22 (~block 140M), implying a ~11M-block walk that should take ~5h. The 30-second duration on the larger of the two test runs confirms these were dry-test slices, not the full historical walk.

Waiting on Trevor to run with no `--floor-block` override (or with `--floor-date=2025-11-22`). Once a row exists with `blocks_scanned` in the millions and a duration in the hours, re-measurement of the AllDay divergence vs. Flowty becomes meaningful per Round 11 Item 3's plan, and `docs/audits/listing-divergence-2026-05.md` gets the post-backfill section.
