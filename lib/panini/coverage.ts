// lib/panini/coverage.ts
//
// The listing-gated coverage disclosure for Panini's SHARED collection surfaces
// (/panini-blockchain/overview + /market, published 2026-09-25). Panini publishes
// no checklist, so RPC indexes a card only once it has been listed for sale —
// every Panini number is a floor, not a census. The squeeze board has carried
// this disclosure since 2026-08-01; the shared tabs carry it from the same view.
//
// Three states, never two:
//   { ok: true, coverage }  — read ok, figures available
//   { ok: true, coverage: null } — read ok, view returned no usable row
//   { ok: false }           — read failed
// The CLIENT always renders the principle ("listed cards only — a floor, not a
// census") and adds the figures only when it has them, so a failed read removes
// numbers, never the disclosure.

import { boundedRead } from "@/lib/api/bounded-read"

export interface PaniniCoverage {
  total_editions: number
  pct_trustworthy: number | null
  listing_gated_editions: number | null
  listing_gated_families: number | null
  families: number | null
  edition_age_p50_h: number | null
  edition_age_p90_h: number | null
  pct_editions_stale_45d: number | null
}

export type PaniniCoverageRead = { ok: true; coverage: PaniniCoverage | null } | { ok: false }

const COLUMNS =
  "total_editions,pct_trustworthy,listing_gated_editions,listing_gated_families,families," +
  "edition_age_p50_h,edition_age_p90_h,pct_editions_stale_45d"

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Parse one `panini_coverage_summary` row; null when it carries no editions. */
export function parsePaniniCoverage(row: unknown): PaniniCoverage | null {
  if (!row || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  const total = numOrNull(r.total_editions)
  // A total of zero is not "0% covered" — it is no measurement.
  if (total == null || total <= 0) return null
  return {
    total_editions: total,
    pct_trustworthy: numOrNull(r.pct_trustworthy),
    listing_gated_editions: numOrNull(r.listing_gated_editions),
    listing_gated_families: numOrNull(r.listing_gated_families),
    families: numOrNull(r.families),
    edition_age_p50_h: numOrNull(r.edition_age_p50_h),
    edition_age_p90_h: numOrNull(r.edition_age_p90_h),
    pct_editions_stale_45d: numOrNull(r.pct_editions_stale_45d),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniCoverage(db: any, where: string): Promise<PaniniCoverageRead> {
  try {
    const { data, error } = await boundedRead(
      db.from("panini_coverage_summary").select(COLUMNS).limit(1),
      where,
    )
    if (error) {
      console.log(`[${where}] panini coverage read failed: ${error.message ?? error}`)
      return { ok: false }
    }
    return { ok: true, coverage: parsePaniniCoverage((data ?? [])[0]) }
  } catch (err) {
    console.log(`[${where}] panini coverage read threw: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}
