// app/api/og/insights/pinnacle-market/route.tsx
//
// Open Graph card for /insights/pinnacle-market (2026-11-23): the shared /insights/market card rendered for Disney
// Pinnacle (its `?collection=disney-pinnacle` leg — the rows it reads and the collection it names). Its own path so the
// board's layout references its own card.

import { NextRequest } from "next/server"
import { GET as sharedCard } from "../market/route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET(req: NextRequest) {
  const url = new URL(req.url)
  url.pathname = "/api/og/insights/market"
  url.searchParams.set("collection", "disney-pinnacle")
  return sharedCard(new NextRequest(url))
}
