// lib/panini/product-volume.ts — the Panini Analytics "Top products by volume" rows (2026-10-25). Plain module (no
// "use client") so the server page can call topProductsByVolume; the client component imports only the type.

/** One product's 30-day sales on record (panini_product_rollup), for the "by product" table. */
export interface PaniniProductVolumeRow {
  name: string
  slug: string
  sales_30d: number
  sales_30d_volume_usd: number | null
  sales_30d_median_usd: number | null
}

/** Products with a sale on record, biggest 30-day volume first (pure; the page feeds it the products list). */
export function topProductsByVolume(rows: PaniniProductVolumeRow[] | null, limit = 15): PaniniProductVolumeRow[] | null {
  if (rows === null) return null
  return rows
    .filter((r) => r.sales_30d > 0)
    .sort((a, b) => (b.sales_30d_volume_usd ?? 0) - (a.sales_30d_volume_usd ?? 0) || b.sales_30d - a.sales_30d || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** One league / brand's 30-day sales on record (get_panini_property_board), for the "by league" table (2026-11-27). */
export interface PaniniLeagueVolumeRow {
  slug: string
  name: string
  products: number
  sales_30d: number
  sales_30d_volume_usd: number | null
}

/**
 * Leagues / brands with a sale on record in the last 30 days, biggest volume first. null in = the read failed
 * (the section says so); a league with no sale is left out, never shown as $0.
 */
export function leaguesByVolume(rows: PaniniLeagueVolumeRow[] | null): PaniniLeagueVolumeRow[] | null {
  if (rows === null) return null
  return rows
    .filter((r) => r.sales_30d > 0)
    .map((r) => ({ slug: r.slug, name: r.name, products: r.products, sales_30d: r.sales_30d, sales_30d_volume_usd: r.sales_30d_volume_usd }))
    .sort((a, b) => (b.sales_30d_volume_usd ?? 0) - (a.sales_30d_volume_usd ?? 0) || b.sales_30d - a.sales_30d || a.name.localeCompare(b.name))
}
