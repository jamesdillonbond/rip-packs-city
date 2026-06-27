// app/api/public/insights/rookie-board/route.ts
//
// Public JSON for the Rookie Edition Board. Reads the anon-granted
// topshot_rookie_edition_board view via the service-role client. Feeds the page
// (when filtered server-side), the OG card, and external consumers.
//
// Honesty: parallel (::subID) rows carry FMV + circulation ONLY — every
// ask/offer/sale/burn/lock field is NULL. The `has_full_economics` flag tells a
// consumer which fields are real; the view already enforces it.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import {
  fetchRookieEditionBoard,
  type RookieBoardMode,
  type RookieSortKey,
} from "@/lib/rookie-edition-board"

const VALID_TIERS = new Set(["COMMON", "RARE", "FANDOM", "LEGENDARY", "ULTIMATE"])
const VALID_SORTS = new Set<RookieSortKey>(["fmv", "burned", "burn_rate", "circulation", "lock_rate"])

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const mode: RookieBoardMode = sp.get("mode")?.trim().toLowerCase() === "burn" ? "burn" : "board"

  const tier = sp.get("tier")?.trim().toUpperCase() || null
  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${[...VALID_TIERS].join(",")}` },
      { status: 400 }
    )
  }

  const parallelRaw = sp.get("parallel_id")
  let parallelId: number | null = null
  if (parallelRaw != null && parallelRaw !== "") {
    const p = Number(parallelRaw)
    if (!Number.isInteger(p) || p < 0) {
      return NextResponse.json({ error: "parallel_id must be a non-negative integer" }, { status: 400 })
    }
    parallelId = p
  }

  const player = sp.get("player")?.trim() || null
  const set = sp.get("set")?.trim() || null

  const sortRaw = (sp.get("sort")?.trim().toLowerCase() || "") as RookieSortKey
  // Default sort depends on mode: burn rankings lead with burn count.
  const sort: RookieSortKey = VALID_SORTS.has(sortRaw) ? sortRaw : mode === "burn" ? "burned" : "fmv"

  // Whole board is ~431 rows; allow fetching all of it for the grouped view.
  const limit = Math.max(1, Math.min(500, Number(sp.get("limit") ?? "500")))

  let rows
  try {
    rows = await fetchRookieEditionBoard(supabase, { mode, tier, parallelId, player, set, sort, limit })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/insights/rookie-board]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/insights/rookie-board] mode=${mode} sort=${sort} tier=${tier ?? "*"} returned=${rows.length} in ${elapsedMs}ms`
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "topshot_rookie_edition_board",
      mode,
      total_rows: rows.length,
      elapsed_ms: elapsedMs,
      filters: { mode, tier, parallel_id: parallelId, player, set, sort, limit },
    },
    rows,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
