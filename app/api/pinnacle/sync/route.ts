import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  syncPinnacleEditions,
  syncPinnacleListings,
} from "@/lib/pinnacle/sync"

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const authHeader = req.headers.get("authorization")
    if (authHeader === `Bearer ${cronSecret}`) return true
  }

  // If no secret is configured, allow access (dev mode)
  if (!cronSecret) return true

  return false
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const editions = await syncPinnacleEditions(supabaseAdmin)
  const listings = await syncPinnacleListings(supabaseAdmin)

  return NextResponse.json({
    editions_upserted: editions.upserted,
    listings_upserted: listings.upserted,
    errors: [...editions.errors, ...listings.errors],
  })
}
