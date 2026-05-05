// app/api/pinnacle-sniper/route.ts
// GET /api/pinnacle-sniper — Disney Pinnacle sniper deals.
// Thin wrapper over computePinnacleSniperFeed (lib/sniper/pinnacle.ts), so
// /api/sniper-feed?collection=disney-pinnacle and the legacy dedicated
// route share one code path.

import { NextRequest, NextResponse } from "next/server"
import { computePinnacleSniperFeed } from "@/lib/sniper/pinnacle"

export const dynamic = "force-dynamic"
export const maxDuration = 25

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const result = await computePinnacleSniperFeed({
    variantFilter: url.searchParams.get("tier") ?? url.searchParams.get("variant") ?? "all",
    maxPrice: parseFloat(url.searchParams.get("maxPrice") ?? "0"),
    minDiscount: parseFloat(url.searchParams.get("minDiscount") ?? "0"),
    playerFilter: url.searchParams.get("player") ?? "",
    sortBy: url.searchParams.get("sortBy") ?? "discount",
  })

  return NextResponse.json(result, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
    },
  })
}
