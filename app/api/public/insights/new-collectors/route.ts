// app/api/public/insights/new-collectors/route.ts
//
// PUBLIC INSIGHTS — New Collectors. NBA Top Shot's acquisition funnel + cohort
// retention, computed from buyer-resolved on-chain marketplace sales. Backs
// /insights/new-collectors. Under /api/public/* so proxy.ts lets anon through.
//
// One fetch powers the whole page: the four anon-granted MVs (summary / spend /
// gateway / cohorts), shaped by lib/new-collectors-board.ts (same shape the
// server page renders, so the API and the page never diverge).
//
// COVERAGE HONESTY: active/returning/market-$ and composition are reliable for
// recent windows (~92% of active buyers captured). Raw new-buyer COUNT is
// inflated by partial historical buyer coverage; new_debiased strips wallets
// seen selling before their first observed buy. Self-corrects as the deep buyer
// backfill lands. The caveat travels in meta.coverage_note.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { fetchNewCollectorsBoard, COVERAGE_NOTE } from "@/lib/new-collectors-board"

export async function GET(_req: NextRequest) {
  const startedAt = Date.now()
  try {
    const board = await fetchNewCollectorsBoard(supabase)
    const elapsedMs = Date.now() - startedAt
    console.log(
      `[public/insights/new-collectors] windows=${board.summary.length} cohorts=${board.cohorts.length} elapsedMs=${elapsedMs}`
    )
    const res = NextResponse.json({
      meta: {
        fetched_at: new Date().toISOString(),
        computed_at: board.computed_at,
        source: "mv_insights_new_collectors_*",
        elapsed_ms: elapsedMs,
        coverage_note: COVERAGE_NOTE,
      },
      summary: board.summary,
      spend: board.spend,
      gateway: board.gateway,
      cohorts: board.cohorts,
    })
    // The MVs are refreshed daily; the edge cache just bounds a viral OG-share spike.
    res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=1800")
    return res
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/insights/new-collectors]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
