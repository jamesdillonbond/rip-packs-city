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
  /** player / driver / character / artist — who is on the cards (subjectPlural()). */
  subject_word: string
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
      subject_word: str(raw.subject_word) ?? "player",
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

/** A league / brand's own page (2026-11-26, migration 20261126193845). */
export function paniniPropertyHref(collection: string, slug: string): string {
  return `/${collection}/property/${encodeURIComponent(slug)}`
}

/** Its section of the products index. */
export function paniniPropertyIndexHref(collection: string, slug: string): string {
  return `/${collection}/product#${slug}`
}

// "Players" / "Characters" / "Artists" … lives in lib/property-words.ts (client-safe, shared with Candy).
export { subjectPlural } from "@/lib/property-words"

/** "2021 to 2024-25", or the single season; null when no product name carries one. */
export function seasonSpan(p: Pick<PaniniProperty, "first_season" | "last_season">): string | null {
  if (!p.first_season && !p.last_season) return null
  if (!p.first_season || !p.last_season || p.first_season === p.last_season) return p.last_season ?? p.first_season
  return `${p.first_season} to ${p.last_season}`
}

// ── The page per league / brand ─────────────────────────────────────────────────────────────────────────

export interface PaniniPropertyProduct {
  slug: string
  name: string
  season: string | null
  editions: number
  sets: number
  fmv_total_usd: number | null
  listed_editions: number
  sales_30d: number
  sales_30d_volume_usd: number | null
}

export interface PaniniPropertySubject {
  player_name: string
  editions: number
  priced_editions: number
  fmv_total_usd: number | null
}

export interface PaniniPropertyEdition {
  external_id: string
  player_name: string | null
  parallel: string | null
  set_name: string | null
  mint_cap: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  low_ask_usd: number | null
}

export interface PaniniPropertySale {
  external_id: string
  player_name: string | null
  parallel: string | null
  sku: string
  amount_usd: number
  sold_at: string
}

export interface PaniniPropertyPage {
  slug: string
  name: string
  heading: PaniniPropertyHeading
  category: string
  subject_word: string
  group_word: string | null
  team_league: string | null
  computed_at: string | null
  products: PaniniPropertyProduct[]
  editions: number
  priced_editions: number
  fmv_total_usd: number | null
  listed_editions: number
  cheapest_ask_usd: number | null
  sales_30d: number
  sales_30d_volume_usd: number | null
  newest_sale_at: string | null
  first_season: string | null
  last_season: string | null
  top_editions: PaniniPropertyEdition[]
  top_sales_90d: PaniniPropertySale[]
  top_subjects: PaniniPropertySubject[]
}

/** ok:false = the read failed; ok:true + null = no such league / brand, or one with no product page yet (404). */
export type PaniniPropertyPageRead = { ok: true; page: PaniniPropertyPage | null } | { ok: false; page: null }

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => rec(x)) as Record<string, unknown>[]) : [])

/** Pure parse; `undefined` = not the expected shape (a failed read). */
export function toPropertyPage(data: unknown): PaniniPropertyPage | null | undefined {
  if (data === null || data === undefined) return null
  const d = rec(data)
  const prop = rec(d?.property)
  const totals = rec(d?.totals)
  if (!d || !prop || !totals || !Array.isArray(d.products)) return undefined
  const slug = str(prop.slug)
  const name = str(prop.name)
  const heading = prop.heading === "leagues" || prop.heading === "entertainment" ? prop.heading : null
  if (!slug || !name || !heading) return undefined
  const products: PaniniPropertyProduct[] = []
  for (const r of list(d.products)) {
    const ps = str(r.slug)
    const pn = str(r.name)
    if (!ps || !pn) continue
    products.push({
      slug: ps,
      name: pn,
      season: str(r.season),
      editions: num(r.editions) ?? 0,
      sets: num(r.sets) ?? 0,
      fmv_total_usd: num(r.fmv_total_usd),
      listed_editions: num(r.listed_editions) ?? 0,
      sales_30d: num(r.sales_30d) ?? 0,
      sales_30d_volume_usd: num(r.sales_30d_volume_usd),
    })
  }
  if (products.length === 0) return null
  const top_editions: PaniniPropertyEdition[] = []
  for (const r of list(d.top_editions)) {
    const id = str(r.external_id)
    if (!id) continue
    top_editions.push({
      external_id: id,
      player_name: str(r.player_name),
      parallel: str(r.parallel),
      set_name: str(r.set_name),
      mint_cap: num(r.mint_cap),
      thumbnail_url: str(r.thumbnail_url),
      fmv_usd: num(r.fmv_usd),
      low_ask_usd: num(r.low_ask_usd),
    })
  }
  const top_sales_90d: PaniniPropertySale[] = []
  for (const r of list(d.top_sales_90d)) {
    const id = str(r.external_id)
    const sku = str(r.sku)
    const amount = num(r.amount_usd)
    const at = str(r.sold_at)
    if (!id || !sku || amount === null || !at) continue
    top_sales_90d.push({ external_id: id, player_name: str(r.player_name), parallel: str(r.parallel), sku, amount_usd: amount, sold_at: at })
  }
  const top_subjects: PaniniPropertySubject[] = []
  for (const r of list(d.top_subjects)) {
    const pn = str(r.player_name)
    if (!pn) continue
    top_subjects.push({ player_name: pn, editions: num(r.editions) ?? 0, priced_editions: num(r.priced_editions) ?? 0, fmv_total_usd: num(r.fmv_total_usd) })
  }
  return {
    slug,
    name,
    heading,
    category: str(prop.category) ?? "",
    subject_word: str(prop.subject_word) ?? "player",
    group_word: str(prop.group_word),
    team_league: str(prop.team_league),
    computed_at: str(d.computed_at),
    products,
    editions: num(totals.editions) ?? 0,
    priced_editions: num(totals.priced_editions) ?? 0,
    fmv_total_usd: num(totals.fmv_total_usd),
    listed_editions: num(totals.listed_editions) ?? 0,
    cheapest_ask_usd: num(totals.cheapest_ask_usd),
    sales_30d: num(totals.sales_30d) ?? 0,
    sales_30d_volume_usd: num(totals.sales_30d_volume_usd),
    newest_sale_at: str(totals.newest_sale_at),
    first_season: str(totals.first_season),
    last_season: str(totals.last_season),
    top_editions,
    top_sales_90d,
    top_subjects,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniPropertyPage(slug: string, db: any = supabaseAdmin): Promise<PaniniPropertyPageRead> {
  try {
    const { data, error } = await withQueryDeadline<unknown>(
      db.rpc("get_panini_property_page", { p_slug: slug, p_limit: 12 }),
      "panini/property-page",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, page: null }
    const page = toPropertyPage(data)
    return page === undefined ? { ok: false, page: null } : { ok: true, page }
  } catch {
    return { ok: false, page: null }
  }
}

/** Shared by the segment layout, generateMetadata and the page: one read per request. */
export const fetchPaniniPropertyPage = cache((slug: string) => readPaniniPropertyPage(slug))
