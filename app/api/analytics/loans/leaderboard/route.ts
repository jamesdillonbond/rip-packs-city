// GET /api/analytics/loans/leaderboard
//
// Top 25 wallets by USD volume in the requested window for a given role.
//
// Query params:
//   role        lender | borrower            (required)
//   window      L7|L30|L90|YTD|2026|2025|ALL (default ALL)
//   collections comma-separated list         (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/loans-window"
import { resolveUsernames, displayName } from "@/lib/flowty-username"

export const revalidate = 600

interface Row {
  funded_at: string | null
  collection: string | null
  principal_usd: number | null
  principal_amount: number | null
  borrower_addr: string | null
  lender_addr: string | null
}

const PAGE_SIZE = 1000
const TOP_N = 25

async function fetchAll(
  startISO: string | null,
  endISO: string | null,
  collections: string[] | null
): Promise<Row[]> {
  const out: Row[] = []
  let from = 0
  while (true) {
    let q = supabaseAdmin
      .from("flowty_loans")
      .select(
        "funded_at,collection,principal_usd,principal_amount,borrower_addr,lender_addr"
      )
      .order("funded_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (collections && collections.length > 0) q = q.in("collection", collections)
    if (startISO) q = q.gte("funded_at", startISO)
    if (endISO) q = q.lt("funded_at", endISO)
    const { data, error } = await q
    if (error || !data) break
    out.push(...(data as Row[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return out
}

function loanUsd(r: Row): number {
  return Number(r.principal_usd ?? r.principal_amount ?? 0) || 0
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const role = (url.searchParams.get("role") || "lender").toLowerCase()
    if (role !== "lender" && role !== "borrower") {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 })
    }
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const range = windowRange(window)

    const inWindow = await fetchAll(range.startISO, range.endISO, collections)
    const fullHistory =
      window === "ALL" ? inWindow : await fetchAll(null, range.endISO, collections)

    type Agg = { addr: string; loanCount: number; totalUsd: number }
    const agg = new Map<string, Agg>()
    for (const r of inWindow) {
      const addr = (role === "lender" ? r.lender_addr : r.borrower_addr) || ""
      if (!addr) continue
      const key = addr.toLowerCase()
      const a = agg.get(key) || { addr: key, loanCount: 0, totalUsd: 0 }
      a.loanCount += 1
      a.totalUsd += loanUsd(r)
      agg.set(key, a)
    }

    const earlierAddrs = new Set<string>()
    if (range.startISO) {
      for (const r of fullHistory) {
        if (!r.funded_at || r.funded_at >= range.startISO) continue
        const addr = (role === "lender" ? r.lender_addr : r.borrower_addr) || ""
        if (addr) earlierAddrs.add(addr.toLowerCase())
      }
    }

    const ranked = Array.from(agg.values())
      .sort((a, b) => b.totalUsd - a.totalUsd || b.loanCount - a.loanCount)
      .slice(0, TOP_N)

    const names = await resolveUsernames(ranked.map((r) => r.addr))

    const rows = ranked.map((r, i) => ({
      rank: i + 1,
      address: r.addr,
      username: displayName(r.addr, names),
      loanCount: r.loanCount,
      totalUsd: Math.round(r.totalUsd * 100) / 100,
      isReturning: earlierAddrs.has(r.addr),
    }))

    return NextResponse.json(
      { role, window, rows },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/loans/leaderboard] error", e?.message || e)
    return NextResponse.json(
      { error: "leaderboard_failed", message: String(e?.message || e) },
      { status: 500 }
    )
  }
}
