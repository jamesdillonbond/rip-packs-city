import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET() {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_market_pulse_all")
    if (error) {
      console.log("[market-pulse] rpc error:", error.message)
      return NextResponse.json({ error: "Query failed" }, { status: 500 })
    }
    const res = NextResponse.json(data ?? [])
    res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=120")
    return res
  } catch (err) {
    console.log("[market-pulse] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
