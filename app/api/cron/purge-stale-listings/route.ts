import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

async function purgeStaleListings(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabaseAdmin
      .from("cached_listings")
      .delete()
      .lt("cached_at", cutoff)
      .select("id")

    if (error) {
      console.error("[purge-stale-listings] Delete error:", error.message)
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    const deletedCount = data?.length ?? 0
    console.log(`[purge-stale-listings] Purged ${deletedCount} stale listings older than 48h`)

    return NextResponse.json({ ok: true, deletedCount })
  } catch (e) {
    console.error("[purge-stale-listings] Fatal error:", e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Purge failed" },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
  return purgeStaleListings(req)
}

export async function POST(req: NextRequest) {
  return purgeStaleListings(req)
}
