// app/api/og/insights/allday-serial-premiums/route.tsx
//
// Open Graph card for /insights/allday-serial-premiums (2026-10-28): the shared /insights/serial-premiums card
// rendered for NFL All Day (its `?collection=nfl-all-day` leg). Its own path so the board's layout references
// its own card.

import { NextRequest } from "next/server"
import { GET as sharedCard } from "../serial-premiums/route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET(req: NextRequest) {
  const url = new URL(req.url)
  url.pathname = "/api/og/insights/serial-premiums"
  url.searchParams.set("collection", "nfl-all-day")
  return sharedCard(new NextRequest(url))
}
