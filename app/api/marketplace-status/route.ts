// app/api/marketplace-status/route.ts
//
// Thin client-side bridge over `getMarketplaceStatus()`. Sniper / market /
// collection / overview are all client components, so they fetch status
// through this route instead of importing the helper directly.
//
// The helper itself is `unstable_cache`-backed at 5 minutes; we add a
// matching CDN cache header so repeat visits within the same window
// don't even hit our function.

import { NextRequest, NextResponse } from "next/server"
import { getMarketplaceStatus } from "@/lib/marketplace-status"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get("collection") ?? ""
  if (!collection) {
    return NextResponse.json(
      { error: "collection param required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }
  const status = await getMarketplaceStatus(collection)
  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "s-maxage=300, stale-while-revalidate=60",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
