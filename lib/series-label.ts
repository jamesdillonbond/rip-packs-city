import { compactSeriesLabel } from "@/lib/share-card-view"

// Top Shot series encoders. Top Shot stores series as a raw on-chain UInt32
// where 0 = Series 1 (there is NO on-chain series 1 — see the CLAUDE.md series
// map), so a naive `Series ${n}` mislabels every edition. Both the analytics
// board and the moment page decode this via the SAME canonical map below, so
// their labels agree (they previously disagreed on the season labels — analytics
// showed "2023-24" while the moment page showed "Series 2023-24"; unified
// 2026-07-27 onto the internally-consistent "Series 2023-24" form).
//
// The two exported helpers differ only in their FALLBACK for an unmapped series,
// which is a legitimate context difference (not an inconsistency):
//   seriesLabel   — collection-agnostic analytics board; unmapped → "Unknown"
//   seriesDisplay — moment page, Top Shot only; unmapped/non-TS → "Series N"

/** Canonical on-chain-series → display label. Note 0 = "Series 1" (no on-chain 1). */
export const SERIES_DISPLAY: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
  // 2026-10-15: anticipated; CONFIRMED 2026-10-24 — 21 Top Shot editions with series 9
  // were ingested 10-21..10-23 (Series 2026-27 Rookie Debut et al.).
  9: "Series 2026-27",
}

/**
 * The CURRENT Top Shot season — the highest mapped series (2026-10-24: series 9
 * minted its first editions 2026-10-21). Derived from the map so adding the next
 * season's entry moves every reader (the concierge prompt states it) at once.
 */
export const CURRENT_TOP_SHOT_SERIES: number = Math.max(...Object.keys(SERIES_DISPLAY).map(Number))
export const CURRENT_TOP_SHOT_SERIES_LABEL: string = SERIES_DISPLAY[CURRENT_TOP_SHOT_SERIES]

/**
 * NFL All Day on-chain series → the contract's OWN names (AllDay.getSeriesData on
 * 0xe4cf4bdc1751c65d, read 2026-11-24). Two interleaved tracks: odd = contemporary
 * season, even = Historical release. The raw number ("Series 9") reads like a ninth
 * NFL season; it is the 2025 Season. collection_series.display_label still holds
 * "Series N" because it is the series URL key — only what readers see changes.
 * Mirrored in SQL by public.series_display_label (audit_20261124_allday_series_official_labels).
 */
export const ALLDAY_SERIES_DISPLAY: Record<number, string> = {
  1: "Series 1",
  2: "Historical",
  3: "Series 2",
  4: "Historical 2",
  5: "2023 Season",
  6: "Historical (2024 Release)",
  7: "2024 Season",
  8: "Historical (2025 Release)",
  9: "2025 Season",
  10: "Historical (2026 Release)",
}

function isTopShotSlug(slug: string | null | undefined): boolean {
  return slug === "nba_top_shot" || slug === "nba-top-shot"
}
function isAllDaySlug(slug: string | null | undefined): boolean {
  return slug === "nfl_all_day" || slug === "nfl-all-day"
}

/** Analytics-board series label (collection-agnostic). Unmapped/nullish → "Unknown". */
export function seriesLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Unknown"
  return SERIES_DISPLAY[n] ?? "Unknown"
}

/**
 * Analytics-board series label that knows WHICH collection it labels
 * (2026-09-25). `seriesLabel` above decodes every integer through the Top
 * Shot map, so /nfl-all-day/analytics drew "Volume by Series" with "Series
 * 2024-25", "Summer 2021" and two "Unknown" bars for All Day's own series
 * 7, 3, 1 and 9 — the CLAUDE.md "0↔1 is Top-Shot-specific" footgun on a chart.
 * Top Shot keeps the map; any other collection is "Series N"; nullish is
 * "Unknown" (a series the read did not carry, never a fabricated one).
 */
export function analyticsSeriesLabel(n: number | null | undefined, collectionSlug: string | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "Unknown"
  if (isTopShotSlug(collectionSlug)) return SERIES_DISPLAY[Number(n)] ?? "Unknown"
  if (isAllDaySlug(collectionSlug)) return ALLDAY_SERIES_DISPLAY[Number(n)] ?? `Series ${Number(n)}`
  return `Series ${Number(n)}`
}

/**
 * Moment-page series display. Top Shot decodes via SERIES_DISPLAY and All Day via
 * ALLDAY_SERIES_DISPLAY (unmapped n → "Series N"); every other collection's series
 * encoding is unverified, so it falls back to the raw "Series N".
 */
export function seriesDisplay(n: number, collectionSlug: string | null | undefined): string {
  if (isTopShotSlug(collectionSlug)) return SERIES_DISPLAY[n] ?? `Series ${n}`
  if (isAllDaySlug(collectionSlug)) return ALLDAY_SERIES_DISPLAY[n] ?? `Series ${n}`
  return `Series ${n}`
}

/**
 * The label a SERIES PAGE (and any pill linking to it) shows for a
 * collection_series row. Top Shot's `collection_series.display_label` still
 * carries the retired ordinals ("Series 5/6/7") that every edition, set and
 * moment page stopped using on 2026-07-27 — so /nba-top-shot/series/series-7
 * rendered an H1 of "Series 7" for editions the rest of the site labels
 * "Series 2025-26" (found 2026-09-24). The URL slug is derived from the DB
 * label and stays put; only what the reader sees is unified here.
 */
export function seriesPageLabel(
  seriesNumber: number | null | undefined,
  displayLabel: string | null | undefined,
  collectionSlug: string | null | undefined,
): string {
  if (isTopShotSlug(collectionSlug) && seriesNumber != null && SERIES_DISPLAY[seriesNumber]) return SERIES_DISPLAY[seriesNumber]
  if (isAllDaySlug(collectionSlug) && seriesNumber != null && ALLDAY_SERIES_DISPLAY[seriesNumber]) return ALLDAY_SERIES_DISPLAY[seriesNumber]
  return (displayLabel ?? "").trim() || (seriesNumber != null ? `Series ${seriesNumber}` : "Series")
}

/**
 * Series label for an ENTITY TILE. Several entity RPCs (`get_player_editions`,
 * `get_team_top_editions`, `get_pack_contents`) emit `e.series::text` — the raw
 * on-chain number — as `series_label`, so player/team/pack grids printed
 * "5" / "0" / "8" under a tile while the set and series pages print
 * "Series 4" / "Series 1" / "Series 2025-26" (found 2026-09-24). A bare integer
 * is decoded with the Top Shot map, or read as "Series N" elsewhere; a label
 * that is already a phrase passes through.
 */
export function tileSeriesLabel(label: string | null | undefined, collectionSlug: string | null | undefined): string | null {
  if (label == null) return null
  const t = String(label).trim()
  if (!t) return null
  if (!/^\d+$/.test(t)) return t
  return seriesDisplay(Number(t), collectionSlug)
}

/**
 * A SHORT series tag for a dense row ("S3", "'25-26", "Sum '21"), decoded per collection
 * (2026-10-29). Three surfaces printed `S${series}` from the raw on-chain number: the
 * New Collectors gateway sets, the set-squeeze OG card and the trophy-case PDF. On Top
 * Shot that turned on-chain 3 (Summer 2021) into "S3", which is the Series 3 label of
 * on-chain 4, and the 2025-26 season into "S8". Top Shot decodes through SERIES_DISPLAY;
 * any other collection keeps "S{n}".
 */
export function shortSeriesLabel(n: number, collectionSlug: string | null | undefined): string {
  return compactSeriesLabel(seriesDisplay(n, collectionSlug))
}
