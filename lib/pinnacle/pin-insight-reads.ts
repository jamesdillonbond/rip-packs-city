// lib/pinnacle/pin-insight-reads.ts
//
// The three extra reads the pin page's insight chips need (lib/pinnacle/pin-insight-chips.ts), each bounded and
// each failing to NULL (no chip), never to a value. Streamed behind Suspense so they never slow the page.

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface PinChipReads {
  collectorHeld: number | null
  sweepers: number | null
  specialSerial: { serial: number; perfect: boolean; priceUsd: number } | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPinChipFacts(renderId: string, totalMinted: number | null, db: any = supabaseAdmin): Promise<PinChipReads> {
  const [cap, hot, serial] = await Promise.all([
    boundedRead(
      db.from("market_cap_current").select("collector_held")
        .eq("collection_slug", "disney_pinnacle").eq("grain", "edition").eq("match_key", renderId).limit(1),
      "pinnacle-pin-chips/market-cap",
      3_000,
    ).catch(() => ({ data: null, error: { message: "failed" } })),
    boundedRead(db.rpc("get_pinnacle_hot_floors", { p_days: 7 }), "pinnacle-pin-chips/hot-floors", 3_000)
      .catch(() => ({ data: null, error: { message: "failed" } })),
    boundedRead(
      db.from("pinnacle_sales").select("serial_number, sale_price_usd, sold_at")
        .eq("render_id", renderId)
        .in("serial_number", totalMinted != null && totalMinted > 1 ? [1, totalMinted] : [1])
        .gt("sale_price_usd", 0)
        .order("sold_at", { ascending: false })
        .limit(1),
      "pinnacle-pin-chips/special-serial",
      3_000,
    ).catch(() => ({ data: null, error: { message: "failed" } })),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capRow = !cap.error && Array.isArray(cap.data) ? (cap.data as any[])[0] : null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hotRows = !hot.error && Array.isArray((hot.data as any)?.editions) ? ((hot.data as any).editions as any[]) : null
  const hotRow = hotRows?.find((e) => String(e.external_id) === renderId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = !serial.error && Array.isArray(serial.data) ? (serial.data as any[])[0] : null
  const sn = num(s?.serial_number)
  const price = num(s?.sale_price_usd)

  return {
    collectorHeld: num(capRow?.collector_held),
    sweepers: hotRow ? num(hotRow.sweep_buyers) : null,
    specialSerial: sn != null && price != null && price > 0 ? { serial: sn, perfect: sn !== 1, priceUsd: price } : null,
  }
}
