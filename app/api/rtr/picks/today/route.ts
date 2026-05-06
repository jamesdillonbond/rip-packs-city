// app/api/rtr/picks/today/route.ts
//
// Stub: returns an empty picks array until the Odds API key is wired (see
// docs/nba-pipelines.md "Where Prompt 1B (sync-nba-odds) plugs in"). The UI
// renders a "coming soon" card off the empty body so the route can ship now
// and start populating once `sync-nba-odds` lands.

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "rtr-picks-today" }

export async function GET() {
  return NextResponse.json(
    {
      picks: [],
      message: "odds_pending_api_key",
    },
    { headers: ROUTE_HEADERS },
  )
}
