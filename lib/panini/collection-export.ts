// lib/panini/collection-export.ts
//
// panini_collection_export rows → PaniniOwnerCard, so the full-collection CSV
// (/api/panini-collection/export) and the in-page CSV share ONE column contract
// (buildPaniniCollectionCsv). Pure. A missing number is null, never 0.

import type { PaniniOwnerCard } from "@/lib/panini/owner-cards"

/** Past this many cards the export refuses (413) rather than truncate. */
export const PANINI_EXPORT_MAX_CARDS = 40_000

export interface PaniniExportRow {
  sku: string
  edition_key: string | null
  player: string | null
  set: string | null
  sport: string | null
  serial: number | null
  mint_cap: number | null
  is_listed: boolean | null
  ask_usd: number | null
  last_sale_usd: number | null
  last_sale_at: string | null
  is_number_one: boolean | null
  is_jersey_mint: boolean | null
  is_perfect_mint: boolean | null
  catalogued: boolean | null
  fmv_usd: number | null
}

export interface PaniniExportPage {
  username: string
  source: "profile" | "seen"
  rows: PaniniExportRow[]
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

export function paniniExportRowsToCards(rows: PaniniExportRow[]): PaniniOwnerCard[] {
  return rows.map((r) => {
    const flags: string[] = []
    if (r.is_number_one) flags.push("#1")
    if (r.is_jersey_mint) flags.push("jersey")
    if (r.is_perfect_mint) flags.push("last_mint")
    const fmv = num(r.fmv_usd)
    return {
      sku: String(r.sku),
      editionKey: str(r.edition_key),
      serial: num(r.serial),
      mintCap: num(r.mint_cap),
      isListed: r.is_listed === true,
      askUsd: num(r.ask_usd),
      lastSaleUsd: num(r.last_sale_usd),
      lastSaleAt: str(r.last_sale_at),
      seenAt: null,
      flags,
      playerName: str(r.player),
      setName: str(r.set),
      tier: null,
      thumbnailUrl: null,
      fmvUsd: fmv !== null && fmv > 0 ? fmv : null,
      catalogued: r.catalogued === true,
      sport: str(r.sport),
    }
  })
}
