// app/api/public/insights/parallel-premiums/route.ts
//
// PUBLIC INSIGHTS — Parallel Premiums. For every TopShot parallel (::subID)
// edition, the multiple its FMV commands over the Standard base edition of the
// same play (e.g. a Wembanyama Hexwave /25 at ~58x its $1.66 Standard base).
//
// Backed by v_topshot_parallel_premiums (security_invoker=on, anon-granted),
// which reads latest FMV live. This is intelligence neither nbatopshot.com nor
// dapper.market has — both name parallels but neither prices them vs Standard.
//
// Lives under /api/public/* so proxy.ts lets it through with no auth.
//
// Query params:
//   parallel=<name>        subedition_name filter (e.g. Hexwave); optional
//   min_premium=<number>   premium_mult floor; default 1.5
//   conf=high|all          high => both sides HIGH/MEDIUM FMV; default high
//   sort=premium|parallel_fmv|scarcity   default premium
//   limit=<1..200>         default 100
//
// Response: { meta: {...}, rows: [...] }. CACHE: 15-min s-maxage.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { fetchParallelPremiums, type ParallelSortKey } from "@/lib/parallel-premiums-board"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const parallelName = sp.get("parallel")?.trim() || null

  const minPremiumRaw = Number(sp.get("min_premium") ?? "1.5")
  const minPremium = Number.isFinite(minPremiumRaw) && minPremiumRaw > 0 ? minPremiumRaw : 1.5

  const conf = sp.get("conf")?.trim().toLowerCase() === "all" ? "all" : "high"
  const highConfOnly = conf === "high"

  const sortRaw = sp.get("sort")?.trim().toLowerCase() || "premium"
  const sort: ParallelSortKey = (["premium", "parallel_fmv", "scarcity"].includes(sortRaw)
    ? sortRaw
    : "premium") as ParallelSortKey

  const limit = Math.max(1, Math.min(200, Number(sp.get("limit")) || 100))

  let rows
  try {
    rows = await fetchParallelPremiums(supabase, { parallelName, minPremium, highConfOnly, sort, limit })
  } catch (e) {
    return boardUnavailable(e, "insights/parallel-premiums")
  }

  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/insights/parallel-premiums] returned=${rows.length} parallel=${parallelName ?? "*"} conf=${conf} min=${minPremium} sort=${sort} elapsedMs=${elapsedMs}`
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "v_topshot_parallel_premiums",
      total_rows: rows.length,
      elapsed_ms: elapsedMs,
      filters: { parallel: parallelName, min_premium: minPremium, conf, sort, limit },
    },
    rows,
  })
  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
