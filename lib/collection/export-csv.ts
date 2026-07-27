// lib/collection/export-csv.ts
//
// Pure CSV builder for the collection page's "Export CSV" action. Extracted
// verbatim from app/(collections)/[collection]/collection/page.tsx's
// handleExportCsv (monolith Phase-2 slice) so the row→CSV mapping is a
// standalone, unit-tested surface instead of buried in the 1,600-line page.
// The browser-side Blob download stays in the component; only the string
// construction — the part worth testing — lives here.

import { normalizeSetName } from "@/lib/wallet-normalize"
import {
  seriesDisplayLabel,
  formatAcquiredAt,
  getParallel,
  getSerial,
  getMint,
} from "@/lib/collection/helpers"
import type { MomentRow, CollectionSeriesEntry } from "@/lib/collection/types"

// Column order is the user-facing export contract — keep stable.
export const COLLECTION_CSV_HEADERS = [
  "Player",
  "Set",
  "Series",
  "Tier",
  "Parallel",
  "Serial",
  "Circulation",
  "FMV",
  "Low Ask",
  "Best Offer",
  "Badges",
  "Acquired",
] as const

// Escape a single cell RFC-4180 style: wrap in quotes, double any embedded
// quote. Every cell is quoted so commas/newlines in names never break rows.
function csvCell(value: unknown): string {
  return '"' + String(value).replace(/"/g, '""') + '"'
}

// Build the full CSV document (header row + one row per moment) from the
// CURRENT filtered view. Deterministic and DOM-free — the caller handles the
// Blob/download. Behaviour is byte-identical to the former inline builder.
export function buildCollectionCsv(
  rows: MomentRow[],
  collectionSeriesMap?: Map<number, CollectionSeriesEntry>,
): string {
  const csvRows = rows.map((r) =>
    [
      r.playerName ?? "",
      normalizeSetName(r.setName) ?? "",
      seriesDisplayLabel(r.series, collectionSeriesMap),
      r.tier ?? "",
      getParallel(r),
      String(getSerial(r) ?? ""),
      String(getMint(r) ?? ""),
      r.fmv != null ? r.fmv.toFixed(2) : "",
      r.lowAsk != null ? r.lowAsk.toFixed(2) : "",
      r.bestOffer != null ? r.bestOffer.toFixed(2) : "",
      (r.badgeInfo?.badge_titles ?? []).join("; "),
      formatAcquiredAt(r.acquiredAt),
    ]
      .map(csvCell)
      .join(","),
  )
  return COLLECTION_CSV_HEADERS.join(",") + "\n" + csvRows.join("\n")
}
