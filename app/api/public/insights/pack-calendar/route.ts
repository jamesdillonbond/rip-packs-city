// app/api/public/insights/pack-calendar/route.ts
//
// PUBLIC INSIGHTS — this week's Dapper pack drops (Top Shot + All Day): what opened in the
// last 7 days, what is open now, and what starts in the next 7, from the Atlas pack book.
// Feeds the @RipPacksCity "drops this week" post (docs/social/x-calendar.md).
//
// Read-only. The book is published only from its last COMPLETE pass (lib/insights/pack-calendar.ts);
// with none, `meta.complete` is false and `drops` is empty — "we could not read the book", never
// "no drops this week". A failed read is a 503 via boardUnavailable(), never an empty 200.
//
// Lives under /api/public/* so the proxy.ts allowlist lets anon through with no auth.
//
// Response: { meta: { fetched_at, source, complete, complete_at, total_drops, elapsed_ms }, drops: [...] }
//
// CACHE: 15-min s-maxage — the book itself refreshes every 15 min.

import { NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { fetchPackCalendar } from "@/lib/insights/pack-calendar"

export async function GET() {
  const startedAt = Date.now()

  let result
  try {
    result = await fetchPackCalendar(supabase)
  } catch (e) {
    return boardUnavailable(e, "insights/pack-calendar")
  }

  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/insights/pack-calendar] drops=${result.drops.length} complete=${result.complete} elapsedMs=${elapsedMs}`,
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "atlas_pack_market (last complete pass)",
      complete: result.complete,
      complete_at: result.complete_at,
      total_drops: result.drops.length,
      elapsed_ms: elapsedMs,
    },
    drops: result.drops,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
