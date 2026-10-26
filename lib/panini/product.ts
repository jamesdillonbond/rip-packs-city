// lib/panini/product.ts
//
// Panini PRODUCT pages (/panini-blockchain/product/<name-slug>) — the Panini counterpart of Top Shot's
// series pages (parity pass 2026-10-25). One row per product NAME in public.panini_product_rollup, rebuilt
// hourly (migrations 20261026012737, …012927, …013714), read through get_panini_product_by_slug(slug), which
// serves only rows from the newest run.
//
// HONESTY: `{ ok:false }` = the read failed (the page says so, never 404s on it); `{ ok:true, product:null }`
// = no such product (404). Every count is editions RPC has SEEN (listing-gated) and every sale is a sale ON
// RECORD — Panini sales reach RPC 12–160 h after they happen.

import { cache } from "react"
import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import type { PaniniProductIndexRow } from "@/components/entity/PaniniProductIndex"

export interface PaniniProductEdition {
  external_id: string
  player_name: string | null
  parallel: string | null
  set_name: string | null
  mint_cap: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  low_ask_usd: number | null
}

export interface PaniniProductSale {
  external_id: string
  player_name: string | null
  parallel: string | null
  sku: string
  amount_usd: number
  sold_at: string
}

export interface PaniniProductSet {
  slug: string
  name: string | null
  editions: number
  listed: number
  fmv_total_usd: number | null
  cheapest_ask_usd: number | null
}

export interface PaniniProduct {
  product_set_id: number
  /** Every Panini set id with editions that carries this product name. */
  product_set_ids: number[]
  name: string
  slug: string
  sport: string | null
  editions: number
  players: number
  sets: number
  priced_editions: number
  fmv_total_usd: number | null
  listed_editions: number
  cheapest_ask_usd: number | null
  sales_30d: number
  sales_30d_volume_usd: number | null
  sales_30d_median_usd: number | null
  newest_sale_at: string | null
  top_editions: PaniniProductEdition[]
  top_sales_90d: PaniniProductSale[]
  sets_list: PaniniProductSet[]
  computed_at: string
}

export { paniniProductHref, paniniProductSlug, serialLabelOfSku } from "@/lib/panini/product-url"

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

export function toProduct(r: Record<string, unknown>): PaniniProduct | null {
  const id = num(r.product_set_id)
  if (id === null || typeof r.slug !== "string" || typeof r.name !== "string") return null
  return {
    product_set_id: id,
    product_set_ids: arr<unknown>(r.product_set_ids).map(Number).filter((n) => Number.isSafeInteger(n)),
    name: r.name,
    slug: r.slug,
    sport: typeof r.sport === "string" ? r.sport : null,
    editions: num(r.editions) ?? 0,
    players: num(r.players) ?? 0,
    sets: num(r.sets) ?? 0,
    priced_editions: num(r.priced_editions) ?? 0,
    fmv_total_usd: num(r.fmv_total_usd),
    listed_editions: num(r.listed_editions) ?? 0,
    cheapest_ask_usd: num(r.cheapest_ask_usd),
    sales_30d: num(r.sales_30d) ?? 0,
    sales_30d_volume_usd: num(r.sales_30d_volume_usd),
    sales_30d_median_usd: num(r.sales_30d_median_usd),
    newest_sale_at: typeof r.newest_sale_at === "string" ? r.newest_sale_at : null,
    top_editions: arr<PaniniProductEdition>(r.top_editions),
    top_sales_90d: arr<PaniniProductSale>(r.top_sales_90d),
    sets_list: arr<PaniniProductSet>(r.sets_list),
    computed_at: typeof r.computed_at === "string" ? r.computed_at : "",
  }
}

export type PaniniProductRead = { ok: true; product: PaniniProduct | null } | { ok: false; product: null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniProduct(slug: string, db: any = supabaseAdmin): Promise<PaniniProductRead> {
  try {
    const { data, error } = await withQueryDeadline<unknown>(
      db.rpc("get_panini_product_by_slug", { p_slug: slug }),
      "panini/product",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, product: null }
    if (data === null || data === undefined) return { ok: true, product: null }
    if (typeof data !== "object") return { ok: false, product: null }
    const p = toProduct(data as Record<string, unknown>)
    return p ? { ok: true, product: p } : { ok: false, product: null }
  } catch {
    return { ok: false, product: null }
  }
}

/** Shared by the segment layout, generateMetadata and the page: one read per request. */
export const fetchPaniniProduct = cache((slug: string) => readPaniniProduct(slug))


/**
 * Every product page (newest rollup run), for the products index. null = the read failed. ~67 rows, under the
 * PostgREST clamp; a full page (1,000) is treated as a failed read rather than a silently truncated list.
 */
export async function listPaniniProducts(db: any = supabaseAdmin): Promise<PaniniProductIndexRow[] | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const { data, error } = await withQueryDeadline<Record<string, unknown>[]>(
      db.from("panini_product_rollup")
        .select("name,slug,sport,editions,sets,fmv_total_usd,listed_editions,sales_30d,sales_30d_volume_usd,sales_30d_median_usd,computed_at")
        .order("product_set_id", { ascending: true })
        .range(0, 999),
      "panini/product-index",
      apiReadTimeoutMs(),
    )
    if (error || !Array.isArray(data) || data.length >= 1000) return null
    const newest = data.reduce<string>((m, r) => (typeof r.computed_at === "string" && r.computed_at > m ? r.computed_at : m), "")
    return data
      .filter((r) => r.computed_at === newest && typeof r.slug === "string" && typeof r.name === "string")
      .map((r) => ({
        name: r.name as string,
        slug: r.slug as string,
        sport: typeof r.sport === "string" ? r.sport : null,
        editions: num(r.editions) ?? 0,
        sets: num(r.sets) ?? 0,
        fmv_total_usd: num(r.fmv_total_usd),
        listed_editions: num(r.listed_editions) ?? 0,
        sales_30d: num(r.sales_30d) ?? 0,
        sales_30d_volume_usd: num(r.sales_30d_volume_usd),
        sales_30d_median_usd: num(r.sales_30d_median_usd),
      }))
  } catch {
    return null
  }
}
