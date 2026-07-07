// lib/market-pulse-board.ts
//
// Shape + fetch for the public Market Pulse board. Backed by the SECURITY
// DEFINER RPC get_market_pulse_windows() (service_role), which aggregates every
// collection's secondary sales across 24h / 7d / 30d from `sales` (+ Pinnacle
// from `pinnacle_sales`). Cross-collection is a Dapper/Top Shot gap (their
// insights are single-league).

export type MarketPulseRow = {
  slug: string
  collection_name: string
  sales_24h: number
  volume_24h: number
  buyers_24h: number
  top_sale_24h: number | null
  sales_7d: number
  volume_7d: number
  buyers_7d: number
  sellers_7d: number
  top_sale_7d: number | null
  sales_30d: number
  volume_30d: number
  buyers_30d: number
  top_sale_30d: number | null
}

export async function fetchMarketPulse(supabase: any): Promise<MarketPulseRow[]> {
  const { data, error } = await supabase.rpc("get_market_pulse_windows")
  if (error) throw new Error(error.message)
  return (Array.isArray(data) ? data : []) as MarketPulseRow[]
}
