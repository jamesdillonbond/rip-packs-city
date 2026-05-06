// app/api/rtr/picks/today/route.ts
//
// Returns tonight's recommended Road to the Ring pick — the single
// highest-implied-probability moneyline across nba_games rows whose odds
// were refreshed within the last 90 minutes. Reads from `nba_games`
// directly via supabaseAdmin so the route is unauthenticated and cheap.
// When no fresh odds exist (off-night, off-season, sync-nba-odds outage)
// the route returns picks: [] with message: "no_fresh_odds" so the UI can
// render the graceful fallback card.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { pickTonightsBest } from "@/lib/rtr-picks"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "rtr-picks-today" }

export async function GET() {
  const top = await pickTonightsBest(supabaseAdmin, { freshnessMin: 90 })
  if (!top) {
    return NextResponse.json(
      {
        picks: [],
        message: "no_fresh_odds",
        note:
          "No game odds in the last 90 minutes. Cron pulls every 60 min during NBA active hours; check back closer to tipoff.",
      },
      { headers: ROUTE_HEADERS },
    )
  }
  return NextResponse.json(
    {
      picks: [
        {
          gameId: top.gameId,
          homeTeam: top.homeTeam,
          awayTeam: top.awayTeam,
          recommendedSide: top.recommendedSide,
          impliedProbability: top.impliedProbability,
          rationale: top.rationale,
          homeML: top.homeML,
          awayML: top.awayML,
          tipoffAt: top.tipoffAt,
          bookmaker: top.bookmaker,
          oddsLastSyncedAt: top.oddsLastSyncedAt,
        },
      ],
    },
    { headers: ROUTE_HEADERS },
  )
}
