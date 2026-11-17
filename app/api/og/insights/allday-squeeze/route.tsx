// app/api/og/insights/allday-squeeze/route.tsx
//
// Open Graph card for /insights/allday-squeeze (2026-10-27): the shared /insights/squeeze
// card rendered for NFL All Day (its `?collection=nfl-all-day` leg — the rows it reads and
// the collection it names). Its own path so the board's layout references its own card.

import { NextRequest } from "next/server"
import { GET as sharedCard } from "../squeeze/route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET(req: NextRequest) {
  const url = new URL(req.url)
  url.pathname = "/api/og/insights/squeeze"
  url.searchParams.set("collection", "nfl-all-day")
  return sharedCard(new NextRequest(url))
}
