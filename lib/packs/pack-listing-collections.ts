// lib/packs/pack-listing-collections.ts
//
// The collections /api/packs serves (pack_table_rows + EV). Shared by the route's
// allowlist and the site-wide warm-up, so the prewarm cannot drift from what the
// route accepts: until 2026-10-18 the warm-up named Top Shot + All Day only and
// said the route 400s elsewhere, though Pinnacle (07-06) and Golazos (07-07)
// had been served for months.
//
// disney-pinnacle added 2026-07-06 — render-keyed supply-weighted pack EV via
// the compute-pinnacle-pack-ev pipeline; since 2026-09-28 its EV is merged at
// DROP grain from v_pinnacle_pack_drop_ev (app/api/packs/route.ts).
// laliga-golazos re-added 2026-07-07 — the compute-golazos-pack-ev pipeline is
// the AllDay v8 clone (supply/circulation-weighted EV baked into the writer), so
// the base EV in pack_table_rows is already odds-aware; no corrected-EV merge.
export const PACK_LISTING_COLLECTIONS: ReadonlySet<string> = new Set([
  "nba-top-shot",
  "nfl-all-day",
  "disney-pinnacle",
  "laliga-golazos",
])
