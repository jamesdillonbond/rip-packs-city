// app/api/public/insights/set-completers/route.ts
//
// PUBLIC INSIGHTS — Set Completers. Base-play completion for each 2025 Top Shot
// rookie set, computed from the Dune-sourced on-chain ownership index. Backs
// /insights/set-completers. Under /api/public/* so proxy.ts lets anon through.
//
// One fetch powers the page + this API (both call fetchSetCompletersBoard, so
// they never diverge). The backing MV carries no wallet addresses, so it's
// anon-safe; the RPC get_topshot_set_completers is SECURITY DEFINER + anon-granted.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { fetchSetCompletersBoard, METHOD_NOTE } from "@/lib/set-completers-board"

export async function GET(_req: NextRequest) {
  const startedAt = Date.now()
  try {
    const board = await fetchSetCompletersBoard(supabase)
    const elapsedMs = Date.now() - startedAt
    console.log(`[public/insights/set-completers] sets=${board.rows.length} elapsedMs=${elapsedMs}`)
    const res = NextResponse.json({
      meta: {
        fetched_at: new Date().toISOString(),
        source: "topshot_set_completers_mv",
        elapsed_ms: elapsedMs,
        method_note: METHOD_NOTE,
      },
      rows: board.rows,
    })
    // The MV refreshes daily; the edge cache just bounds a viral OG-share spike.
    res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=1800")
    return res
  } catch (e) {
    return boardUnavailable(e, "set-completers")
  }
}
