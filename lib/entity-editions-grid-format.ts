// lib/entity-editions-grid-format.ts
//
// Pure sort / partition / URL / image-candidate logic lifted out of
// components/entity/EditionsGridPaginated.tsx so it lands under the coverage
// ratchet (vitest `include` is lib/** + app/api/**/route.ts only — component
// bodies are invisible). Behavior is identical to the inline versions; the
// component imports these and renders unchanged.
//
// A regression here mis-sorts the edition tile grid, mis-partitions the
// pack-mode "exhausted / pulled out" section, breaks Load-more pagination, or
// drops the Top Shot per-moment image fallback.

import { proxyIpfsUrl } from "@/lib/ipfs-media"

export type EditionSortKey = "fmv_desc" | "circ_asc" | "series_desc" | "alpha"

/** Minimal shape the comparator needs. */
export interface ComparableEdition {
  fmv_usd: number | null
  circulation_count: number | null
  series_num?: number | null
}

/**
 * Sort comparator for the edition grid. Mirrors the inline `compare()`:
 *   fmv_desc    → FMV descending (null FMV sorts as 0)
 *   circ_asc    → circulation ascending (null circulation sorts last via 1e12)
 *   series_desc → series number descending (null series sorts as 0)
 *   alpha       → subject A→Z via the caller-supplied subject function
 * `subjectOf` is injected (the component passes tileSubject) so this module
 * stays free of any React/component import.
 */
export function compareEditions<T extends ComparableEdition>(
  a: T,
  b: T,
  key: EditionSortKey,
  subjectOf: (e: T) => string,
): number {
  const av = a.fmv_usd ?? 0
  const bv = b.fmv_usd ?? 0
  switch (key) {
    case "fmv_desc":
      return bv - av
    case "circ_asc":
      return (a.circulation_count ?? 1e12) - (b.circulation_count ?? 1e12)
    case "series_desc":
      return (b.series_num ?? 0) - (a.series_num ?? 0)
    case "alpha":
      return subjectOf(a).localeCompare(subjectOf(b))
  }
}

// Collections whose editions carry moment clips, so tiles can hover-play video.
// Top Shot / All Day / Golazos / UFC have editions.video_url populated;
// Pinnacle has no video CDN.
const VIDEO_ENABLED_SLUGS: ReadonlySet<string> = new Set([
  "nba-top-shot",
  "nfl-all-day",
  "laliga-golazos",
  "ufc",
])

/** Whether hover-video is enabled for a collection's tiles. */
export function isTileVideoEnabled(collectionUrlSlug: string): boolean {
  return VIDEO_ENABLED_SLUGS.has(collectionUrlSlug)
}

/** Minimal shape for pack-mode partitioning. */
export interface PackPartitionRow {
  drop_weight?: number | null
}

export interface PackPartition<T extends PackPartitionRow> {
  gridRows: T[]
  exhaustedRows: T[]
}

/**
 * Pack-mode split: rows with drop_weight === 0 are exhausted / pulled out and
 * move to the collapsed section; everything else (incl. rows with no
 * drop_weight — every non-pack importer) stays in the main grid. When packMode
 * is off, all rows stay in the grid and there are no exhausted rows.
 */
export function partitionPackRows<T extends PackPartitionRow>(
  rows: T[],
  packMode: boolean,
): PackPartition<T> {
  if (!packMode) return { gridRows: rows, exhaustedRows: [] }
  return {
    gridRows: rows.filter((e) => e.drop_weight !== 0),
    exhaustedRows: rows.filter((e) => e.drop_weight === 0),
  }
}

/**
 * Header count for the exhausted section — the larger of the server-reported
 * total and the number of exhausted rows currently loaded.
 */
export function exhaustedCount(exhaustedTotal: number, loadedExhausted: number): number {
  return Math.max(exhaustedTotal, loadedExhausted)
}

/**
 * Offset-based Load-more URL. Appends offset/limit with the correct separator
 * depending on whether fetchUrl already has a query string.
 */
export function buildLoadMoreUrl(fetchUrl: string, offset: number, pageSize: number): string {
  const sep = fetchUrl.includes("?") ? "&" : "?"
  return `${fetchUrl}${sep}offset=${offset}&limit=${pageSize}`
}

/** Minimal shape for building tile image candidates. */
export interface EditionImageFields {
  rep_nft_id?: string | null
  thumbnail_url: string | null
}

/**
 * Ordered image-source candidates for a tile. For Top Shot with a numeric
 * rep_nft_id, prefer the per-moment media/<nft_id>/image form (works for legacy
 * editions whose stored thumbnail 404s), then fall back to the stored
 * thumbnail (ipfs.io rewritten to the same-origin proxy). Other collections
 * just use the stored thumbnail. TileMedia advances on load error.
 */
export function buildEditionImageCandidates(
  e: EditionImageFields,
  collectionUrlSlug: string,
): string[] {
  const out: string[] = []
  if (collectionUrlSlug === "nba-top-shot" && e.rep_nft_id && /^\d+$/.test(e.rep_nft_id)) {
    out.push(`https://assets.nbatopshot.com/media/${e.rep_nft_id}/image?width=400`)
  }
  if (e.thumbnail_url) {
    const t = proxyIpfsUrl(e.thumbnail_url)
    if (t) out.push(t)
  }
  return out
}
