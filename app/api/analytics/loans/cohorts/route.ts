// GET /api/analytics/loans/cohorts
//
// Quarterly cohorts of borrowers (default) or lenders. Each cohort is the
// set of wallets whose first loan funding falls in that quarter; for each
// subsequent quarter we report the % of that cohort that returned.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/loans-window"

export const revalidate = 600

interface Row {
  funded_at: string | null
  collection: string | null
  borrower_addr: string | null
  lender_addr: string | null
}

const PAGE_SIZE = 1000

async function fetchAll(collections: string[] | null): Promise<Row[]> {
  const out: Row[] = []
  let from = 0
  while (true) {
    let q = supabaseAdmin
      .from("flowty_loans")
      .select("funded_at,collection,borrower_addr,lender_addr")
      .not("funded_at", "is", null)
      .order("funded_at", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (collections && collections.length > 0) q = q.in("collection", collections)
    const { data, error } = await q
    if (error || !data) break
    out.push(...(data as Row[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return out
}

function quarterKey(iso: string): string {
  const d = new Date(iso)
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  return `${d.getUTCFullYear()}Q${q}`
}

function quarterLabel(qk: string): string {
  const [year, q] = qk.split("Q")
  return `Q${q} ${year}`
}

function nextQuarter(qk: string): string {
  const [yearStr, qStr] = qk.split("Q")
  let y = parseInt(yearStr, 10)
  let q = parseInt(qStr, 10) + 1
  if (q > 4) {
    q = 1
    y += 1
  }
  return `${y}Q${q}`
}

function compareQuarter(a: string, b: string): number {
  return a.localeCompare(b)
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const role = (url.searchParams.get("role") || "borrower").toLowerCase()
    if (role !== "borrower" && role !== "lender") {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 })
    }
    const collections = parseCollections(url.searchParams.get("collections"))
    const rows = await fetchAll(collections)

    if (rows.length === 0) {
      return NextResponse.json(
        { role, cohorts: [], quarters: [] },
        {
          headers: {
            "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
          },
        }
      )
    }

    // address → sorted unique quarters they were active in
    const activity = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!r.funded_at) continue
      const addr = (role === "lender" ? r.lender_addr : r.borrower_addr) || ""
      if (!addr) continue
      const key = addr.toLowerCase()
      const qk = quarterKey(r.funded_at)
      if (!activity.has(key)) activity.set(key, new Set())
      activity.get(key)!.add(qk)
    }

    // Determine cohort buckets: each address is assigned to its earliest quarter
    const cohortMembers = new Map<string, string[]>() // cohortQuarter → addresses
    const allQuarters = new Set<string>()
    for (const [addr, quarters] of activity.entries()) {
      const sorted = Array.from(quarters).sort(compareQuarter)
      const earliest = sorted[0]
      for (const q of sorted) allQuarters.add(q)
      if (!cohortMembers.has(earliest)) cohortMembers.set(earliest, [])
      cohortMembers.get(earliest)!.push(addr)
    }

    const cohortQuarters = Array.from(cohortMembers.keys()).sort(compareQuarter)
    const allQuartersSorted = Array.from(allQuarters).sort(compareQuarter)
    const latest = allQuartersSorted[allQuartersSorted.length - 1]

    const cohorts = cohortQuarters.map((cohortQ) => {
      const members = cohortMembers.get(cohortQ) || []
      const size = members.length
      const retention: Array<{ quarter: string; pct: number; count: number }> = []
      let q = cohortQ
      while (q && compareQuarter(q, latest) <= 0) {
        let active = 0
        for (const addr of members) {
          if (activity.get(addr)?.has(q)) active++
        }
        retention.push({
          quarter: q,
          count: active,
          pct: size > 0 ? Math.round((active / size) * 1000) / 10 : 0,
        })
        q = nextQuarter(q)
      }
      return {
        cohort: cohortQ,
        cohortLabel: quarterLabel(cohortQ),
        size,
        retention,
      }
    })

    return NextResponse.json(
      {
        role,
        cohorts,
        quarters: allQuartersSorted,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/loans/cohorts] error", e?.message || e)
    return NextResponse.json(
      { error: "cohorts_failed", message: String(e?.message || e) },
      { status: 500 }
    )
  }
}
