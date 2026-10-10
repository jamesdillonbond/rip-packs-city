// lib/insights/panini-premiums.ts
//
// The two Panini premium boards behind /insights/panini-premiums (2026-10-10), modelled on Top
// Shot's /insights/parallel-premiums and /insights/serial-premiums:
//   · parallels — panini_parallel_premiums: a numbered base parallel's FMV over the same player's
//     most common base parallel in the same product. Read at HIGH/MEDIUM on BOTH sides and a
//     premium of at least 1.5x (Top Shot's board defaults), so a LOW price never heads the board.
//   · serials   — panini_serial_premiums: real sales of an edition's #1 or perfect mint at >= 2x
//     the median of its other sales in 90 days.
// Both views are service-role only (panini_* tables have no anon grant): this module is the one
// reader, server-side. A failed read THROWS — the page's fetchBoardForPage turns that into an
// honest "couldn't load" (initialFailed), never an empty board.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const PANINI_PREMIUMS_LIMIT = 200
export const PANINI_PARALLEL_MIN_PREMIUM = 1.5

export interface PaniniParallelPremium {
  product_set_id: number | null
  product_name: string | null
  sport: string | null
  player_name: string | null
  external_id: string
  parallel: string | null
  mint_cap: number | null
  thumbnail_url: string | null
  parallel_fmv_usd: number | null
  parallel_confidence: string | null
  base_external_id: string | null
  base_parallel: string | null
  base_mint_cap: number | null
  base_fmv_usd: number | null
  base_confidence: string | null
  premium_mult: number | null
}

export interface PaniniSerialPremium {
  product_set_id: number | null
  product_name: string | null
  sport: string | null
  player_name: string | null
  parallel: string | null
  thumbnail_url: string | null
  external_id: string
  sku: string
  serial_number: number | null
  mint_cap: number | null
  headline: string | null
  sale_usd: number | null
  sold_at: string | null
  edition_median_usd: number | null
  edition_sales_n: number | null
  premium_mult: number | null
}

export interface PaniniPremiumsPayload {
  parallels: PaniniParallelPremium[]
  parallelsCapped: boolean
  serials: PaniniSerialPremium[]
  serialsCapped: boolean
}

const PARALLEL_COLS =
  "product_set_id,product_name,sport,player_name,external_id,parallel,mint_cap,thumbnail_url,parallel_fmv_usd,parallel_confidence," +
  "base_external_id,base_parallel,base_mint_cap,base_fmv_usd,base_confidence,premium_mult"
const SERIAL_COLS =
  "product_set_id,product_name,sport,player_name,parallel,thumbnail_url,external_id,sku,serial_number,mint_cap,headline,sale_usd,sold_at," +
  "edition_median_usd,edition_sales_n,premium_mult"

const HIGH_MED = ["HIGH", "MEDIUM"]

export async function fetchPaniniPremiums(db: Db): Promise<PaniniPremiumsPayload> {
  const [p, s] = await Promise.all([
    db
      .from("panini_parallel_premiums")
      .select(PARALLEL_COLS)
      .in("parallel_confidence", HIGH_MED)
      .in("base_confidence", HIGH_MED)
      .gte("premium_mult", PANINI_PARALLEL_MIN_PREMIUM)
      .order("premium_mult", { ascending: false })
      .order("external_id", { ascending: true })
      .limit(PANINI_PREMIUMS_LIMIT),
    db
      .from("panini_serial_premiums")
      .select(SERIAL_COLS)
      .order("premium_mult", { ascending: false })
      .order("sku", { ascending: true })
      .order("sold_at", { ascending: false })
      .limit(PANINI_PREMIUMS_LIMIT),
  ])
  // Either board failing fails the read: a page with one board silently empty is a partial page.
  if (p.error) throw new Error(`panini_parallel_premiums: ${p.error.message}`)
  if (s.error) throw new Error(`panini_serial_premiums: ${s.error.message}`)
  const parallels = (p.data ?? []) as PaniniParallelPremium[]
  const serials = (s.data ?? []) as PaniniSerialPremium[]
  return {
    parallels,
    parallelsCapped: parallels.length >= PANINI_PREMIUMS_LIMIT,
    serials,
    serialsCapped: serials.length >= PANINI_PREMIUMS_LIMIT,
  }
}
