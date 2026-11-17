// app/api/public/insights/pack-calendar/route.ts
//
// PUBLIC INSIGHTS — this week's pack drops across every collection RPC can date: Top Shot, All Day,
// Golazos and Pinnacle (the Atlas pack book), Panini (Panini's own store, via the residential runner)
// Pinnacle Open Editions minting now (pinnacle_mint_events — they are not packs) and Candy MLB drop
// announcements (its blog — Candy's store is offline). UFC Strike: market closed.
// What opened in the last 7 days, what is open now, and what starts in the next 7.
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
      source: "atlas_pack_market (last complete pass) + get_pinnacle_open_edition_drops + panini_pack_drops + blog.candy.io/rss",
      complete: result.complete,
      complete_at: result.complete_at,
      total_drops: result.drops.length,
      total_announcements: result.announcements.length,
      not_covered: ["ufc_strike"],
      elapsed_ms: elapsedMs,
    },
    drops: result.drops,
    announcements: result.announcements,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
