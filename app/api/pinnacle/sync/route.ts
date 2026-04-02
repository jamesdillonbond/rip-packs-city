import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { syncPinnacleEditions, syncPinnacleListings } from "@/lib/pinnacle/sync"

// POST /api/pinnacle/sync — cron-protected sync endpoint
export async function POST(req: NextRequest) {
  // Auth: check CRON_SECRET via Authorization bearer header
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const authHeader = req.headers.get("authorization")
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  const errors: string[] = []

  try {
    const editionResult = await syncPinnacleEditions(supabaseAdmin)
    errors.push(...editionResult.errors)

    const listingResult = await syncPinnacleListings(supabaseAdmin)
    errors.push(...listingResult.errors)

    return NextResponse.json({
      editions_upserted: editionResult.upserted,
      listings_upserted: listingResult.upserted,
      errors,
    })
  } catch (err) {
    console.error("[PINNACLE_SYNC_500]", err)
    return NextResponse.json(
      { error: "Sync failed", details: String(err) },
      { status: 500 }
    )
  }
}
