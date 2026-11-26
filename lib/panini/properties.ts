// lib/panini/properties.ts
//
// Panini PROPERTIES (2026-11-26): the league, tournament or IP a Panini product is made under — the level
// between the publisher and a product (public.publisher_properties, panini_products.property_slug, migration
// 20261126185023). ⛔ Collectors never see the word "property": on screen they sit under two headings,
// "Leagues" and "Entertainment" (Trevor 11-26). "property" is for URLs, code and docs.
//
// One read — get_panini_property_board() — serves the overview grid, the grouped products index and the
// product page's breadcrumb. HONESTY: `{ ok:false }` = the read failed (callers fall back to what they showed
// before, never an empty grid stated as fact). Counts are editions RPC has SEEN; sales are those ON RECORD.

import { cache } from "react"
import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

export type PaniniPropertyHeading = "leagues" | "entertainment"

export const PANINI_PROPERTY_HEADINGS: { key: PaniniPropertyHeading; label: string }[] = [
  { key: "leagues", label: "Leagues" },
  { key: "entertainment", label: "Entertainment" },
]

export interface PaniniProperty {
  slug: string
  name: string
  heading: PaniniPropertyHeading
  category: string
  /** /teams/<league> key when RPC has team hubs for it; null otherwise. */
  team_league: string | null
  sort_order: number
  products: number
  editions: number
  /** Sum of the products' FMV totals; null when none is priced (never $0). */
  fmv_total_usd: number | null
  listed_editions: number
  sales_30d: number
  sales_30d_volume_usd: number | null
  /** Season label of the oldest / newest product ("2021", "2024-25"); null when no product name carries one. */
  first_season: string | null
  last_season: string | null
}

export interface PaniniPropertyBoard {
  properties: PaniniProperty[]
  /** product page slug → property slug. */
  productProperty: Record<string, string>
  /** Product pages no rule places (shown under "Other", never guessed). */
  unplacedProducts: number
}

export type PaniniPropertyBoardRead = { ok: true; board: PaniniPropertyBoard } | { ok: false; board: null }

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)

/** Pure parse of the RPC's jsonb; null = not the expected shape (a failed read, not an empty board). */
export function toPropertyBoard(data: unknown): PaniniPropertyBoard | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.properties)) return null
  const properties: PaniniProperty[] = []
  for (const raw of d.properties as Record<string, unknown>[]) {
    const slug = str(raw?.slug)
    const name = str(raw?.name)
    const heading = raw?.heading === "leagues" || raw?.heading === "entertainment" ? raw.heading : null
    if (!slug || !name || !heading) continue
    properties.push({
      slug,
      name,
      heading,
      category: str(raw.category) ?? "",
      team_league: str(raw.team_league),
      sort_order: num(raw.sort_order) ?? 1000,
      products: num(raw.products) ?? 0,
      editions: num(raw.editions) ?? 0,
      fmv_total_usd: num(raw.fmv_total_usd),
      listed_editions: num(raw.listed_editions) ?? 0,
      sales_30d: num(raw.sales_30d) ?? 0,
      sales_30d_volume_usd: num(raw.sales_30d_volume_usd),
      first_season: str(raw.first_season),
      last_season: str(raw.last_season),
    })
  }
  const productProperty: Record<string, string> = {}
  if (d.product_property && typeof d.product_property === "object" && !Array.isArray(d.product_property)) {
    for (const [k, v] of Object.entries(d.product_property as Record<string, unknown>)) {
      if (typeof v === "string" && v) productProperty[k] = v
    }
  }
  return { properties, productProperty, unplacedProducts: num(d.unplaced_products) ?? 0 }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniPropertyBoard(db: any = supabaseAdmin): Promise<PaniniPropertyBoardRead> {
  try {
    const { data, error } = await withQueryDeadline<unknown>(
      db.rpc("get_panini_property_board"),
      "panini/property-board",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, board: null }
    const board = toPropertyBoard(data)
    return board ? { ok: true, board } : { ok: false, board: null }
  } catch {
    return { ok: false, board: null }
  }
}

/** One read per request, shared by the overview grid, the products index and a product page. */
export const fetchPaniniPropertyBoard = cache(() => readPaniniPropertyBoard())

/** Where a property's tile and breadcrumb lead: its section of the products index. */
export function paniniPropertyHref(collection: string, slug: string): string {
  return `/${collection}/product#${slug}`
}

/** "2021 to 2024-25", or the single season; null when no product name carries one. */
export function seasonSpan(p: Pick<PaniniProperty, "first_season" | "last_season">): string | null {
  if (!p.first_season && !p.last_season) return null
  if (!p.first_season || !p.last_season || p.first_season === p.last_season) return p.last_season ?? p.first_season
  return `${p.first_season} to ${p.last_season}`
}
