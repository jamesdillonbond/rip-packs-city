// lib/panini/collection-view.ts
//
// Filter, sort and CSV export for the Panini Collection tab (2026-10-26) — the
// counterpart of Top Shot's collection filter bar, sort bar and "Export CSV"
// (lib/collection/filter-sort.ts, lib/collection/export-csv.ts). Pure and
// client-safe.
//
// Honesty rules:
//   · the tab loads the HIGHEST-FMV cards only (up to 500 of a profile, 200 of a
//     seen list), so the view filters and exports THOSE cards — the caller says
//     "N of M" whenever the loaded set is not the whole collection
//   · an unpriced card sorts after every priced card in both directions and
//     exports an empty FMV cell, never 0
//   · a filter that matches nothing is "no loaded card matches", not "no cards"

import { textIncludes } from "@/lib/filter-match"
import { paniniSportLabel } from "@/lib/panini/sport-label"
import type { PaniniOwnerCard } from "@/lib/panini/owner-cards"

export type PaniniCardSort = "fmv_desc" | "fmv_asc" | "ask_asc" | "serial_asc" | "player_asc"

export const PANINI_CARD_SORTS: { key: PaniniCardSort; label: string }[] = [
  { key: "fmv_desc", label: "FMV · high to low" },
  { key: "fmv_asc", label: "FMV · low to high" },
  { key: "ask_asc", label: "Listed price · low to high" },
  { key: "serial_asc", label: "Serial · low to high" },
  { key: "player_asc", label: "Player · A to Z" },
]

export interface PaniniCardFilter {
  query: string
  sport: string // "" = every sport
  listedOnly: boolean
  specialOnly: boolean
}

export const EMPTY_PANINI_CARD_FILTER: PaniniCardFilter = { query: "", sport: "", listedOnly: false, specialOnly: false }

/** The sports present in the loaded cards, as shown labels, A to Z. */
export function paniniCardSports(cards: PaniniOwnerCard[]): string[] {
  const s = new Set<string>()
  for (const c of cards) if (c.sport) s.add(paniniSportLabel(c.sport))
  return Array.from(s).sort((a, b) => a.localeCompare(b))
}

function listedAsk(c: PaniniOwnerCard): number | null {
  return c.isListed && c.askUsd != null && Number.isFinite(c.askUsd) ? c.askUsd : null
}

/** Nulls last in BOTH directions; ties broken by sku so the order is stable. */
function cmpNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return (a - b) * dir
}

export function filterSortPaniniCards(cards: PaniniOwnerCard[], f: PaniniCardFilter, sort: PaniniCardSort): PaniniOwnerCard[] {
  const q = f.query.trim()
  const out = cards.filter((c) => {
    if (f.listedOnly && listedAsk(c) == null) return false
    if (f.specialOnly && c.flags.length === 0) return false
    if (f.sport && (!c.sport || paniniSportLabel(c.sport) !== f.sport)) return false
    if (q && !textIncludes(c.playerName, q) && !textIncludes(c.setName, q)) return false
    return true
  })
  out.sort((a, b) => {
    let r = 0
    if (sort === "fmv_desc") r = cmpNullable(a.fmvUsd, b.fmvUsd, -1)
    else if (sort === "fmv_asc") r = cmpNullable(a.fmvUsd, b.fmvUsd, 1)
    else if (sort === "ask_asc") r = cmpNullable(listedAsk(a), listedAsk(b), 1)
    else if (sort === "serial_asc") r = cmpNullable(a.serial, b.serial, 1)
    else if (sort === "player_asc") {
      const pa = a.playerName ?? ""
      const pb = b.playerName ?? ""
      r = pa && pb ? pa.localeCompare(pb) : pa ? -1 : pb ? 1 : 0
    }
    return r !== 0 ? r : a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0
  })
  return out
}

// Column order is the user-facing export contract — keep stable.
export const PANINI_COLLECTION_CSV_HEADERS = [
  "Player",
  "Card",
  "Sport",
  "Serial",
  "Mint count",
  "Special",
  "FMV",
  "Listed price",
  "Last sale",
  "Last sale date",
  "RPC edition page",
] as const

function csvCell(value: unknown): string {
  return '"' + String(value).replace(/"/g, '""') + '"'
}
const money = (n: number | null): string => (n != null && Number.isFinite(n) ? n.toFixed(2) : "")
const FLAG_LABEL: Record<string, string> = { "#1": "#1", jersey: "Jersey", last_mint: "Perfect" }

/**
 * CSV of the given cards (the caller passes the CURRENT filtered view). An
 * unpriced card has an empty FMV cell; an uncatalogued card has no edition link.
 */
export function buildPaniniCollectionCsv(cards: PaniniOwnerCard[], origin = "https://www.rippackscity.com"): string {
  const rows = cards.map((c) =>
    [
      c.playerName ?? "",
      c.setName ?? "",
      c.sport ? paniniSportLabel(c.sport) : "",
      c.serial != null ? String(c.serial) : "",
      c.mintCap != null ? String(c.mintCap) : "",
      c.flags.map((x) => FLAG_LABEL[x] ?? x).join("; "),
      c.catalogued ? money(c.fmvUsd) : "",
      money(listedAsk(c)),
      money(c.lastSaleUsd),
      c.lastSaleAt ? c.lastSaleAt.slice(0, 10) : "",
      c.catalogued && c.editionKey ? `${origin}/panini-blockchain/edition/${encodeURIComponent(c.editionKey)}` : "",
    ]
      .map(csvCell)
      .join(","),
  )
  return [PANINI_COLLECTION_CSV_HEADERS.map(csvCell).join(","), ...rows].join("\n")
}
