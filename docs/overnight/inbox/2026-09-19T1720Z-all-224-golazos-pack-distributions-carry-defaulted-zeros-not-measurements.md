# All 224 Golazos `pack_distributions` rows carry defaulted zeros, not measurements

**Filed 2026-09-19 10:20 AM PT (Cowork cloud).** Found while checking whether jobid 27's
`{"done":true}` had left a user-facing number stale. It had not — but this turned up next to it.

## The measurement

`pack_distributions`, grouped by collection:

| collection | dists | depletion NULL | depletion = 0 | depletion > 0 | minted > 0 | sealed > 0 | newest `updated_at` |
|---|---|---|---|---|---|---|---|
| nba_top_shot | 2,443 | 0 | 417 | 2,026 | 2,083 | 2,053 | 2026-09-19 |
| nfl_all_day | 3,076 | 0 | 146 | 2,930 | 3,036 | 1,577 | 2026-09-19 |
| disney_pinnacle | 154 | 0 | 16 | 138 | 153 | 115 | 2026-09-19 |
| **laliga_golazos** | **224** | **0** | **224** | **0** | **0** | **0** | **2026-07-10** |

⭐ **The tell is the PERFECT CORRELATION, and it is the shape CLAUDE.md names.** 224 of 224 sit at
exactly `0` for `total_minted`, `total_sealed`, `total_opened` AND `depletion_pct`, with **zero
NULLs**. A column that is never NULL and never non-zero across an entire collection is reporting
its DEFAULT, not a measurement. Frozen since 2026-07-10 — ~2.3 months.

## ⚠ It is NOT currently user-visible, and I checked rather than assumed

- `lib/pack-dist/fetchers.ts::fetchDistFallback` selects only `metadata, image_url, title` from
  `pack_distributions` — `depletion_pct` is not on the pack-detail path.
- `fetchPackLifecycle` branches on `nfl-all-day` and Top Shot only, and its own comment states
  that any other collection "has no lifecycle source at all — that is `ok: true` with no data,
  not a failure". That is the honest third state, already correct.
- `app/api/cron/compute-laliga-pack-ev/route.ts:249` writes `depletion_pct: null` explicitly, so
  the Golazos rows on the EV surface (which `pack-reality` reads) carry NULL, not 0.
- `app/api/public/insights/topshot-pack-market` is Top Shot only.

**So this is a latent data gap, not a live honesty defect.** Filed at that severity deliberately.

## Why it is still worth a row

The zeros are one join away from becoming a false claim. Anything that later reads
`pack_distributions.depletion_pct` without a collection filter — an OG card, a cross-collection
pack board, a "most depleted packs" list — would publish **"0% opened"** for all 224 Golazos packs
as a measured fact. The guard that would prevent it is the standing one: a function projecting
such a value must project its PROVENANCE too.

## Candidates, in order of cost

1. **Cheapest and most honest:** make the Golazos rows NULL rather than 0 where nothing measured
   them, so the absence is readable. ⚠ Requires first confirming no writer depends on `NOT NULL`
   and no caller does `?? 0` on them — the `?? 0` sweep is the real work here, not the UPDATE.
2. Add a `*_checked_at` column so "never measured" is distinguishable from "measured as zero" —
   the shape CLAUDE.md prescribes for exactly this.
3. Find out whether a Golazos pack-opens lane is supposed to exist at all. There is
   `compute-golazos-pack-ev` (jobid 44) but no Golazos equivalent of
   `backfill-allday-dist-opened` / `ingest-allday-pack-opens` was found. If none is planned,
   option 1 is the whole fix and the column should say so permanently.

⚠ Do NOT "fix" this by backfilling zeros into a `depletion_pct` that nobody measured. That
converts a readable gap into an unreadable fabrication.
