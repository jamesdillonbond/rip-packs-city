// GET /api/analytics/loans/new-wallets
//
// Weekly buckets of first-time borrower / lender counts plus a running
// cumulative. First-seen is computed across the full table history, then
// filtered to the requested window.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/loans-window"

export const revalidate = 600

interface Row {
  funded_at: string | null
  collection: string | null
  borrower_addr: string | null
  lender_addr: string | null
}

const PAGE_SIZE = 1000

async function fetchAll(
  endISO: string | null,
  collections: string[] | null
): Promise<Row[]> {
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
    if (endISO) q = q.lt("funded_at", endISO)
    const { data, error } = await q
    if (error || !data) break
    out.push(...(data as Row[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return out
}

function isoWeekStart(iso: string): string {
  const d = new Date(iso)
  const day = d.getUTCDay() || 7
  const start = new Date(d)
  start.setUTCDate(d.getUTCDate() - day + 1)
  start.setUTCHours(0, 0, 0, 0)
  return start.toISOString().slice(0, 10)
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const range = windowRange(window)

    const rows = await fetchAll(range.endISO, collections)

    // First-seen per role
    const firstLender = new Map<string, string>()
    const firstBorrower = new Map<string, string>()
    for (const r of rows) {
      if (!r.funded_at) continue
      if (r.lender_addr) {
        const a = r.lender_addr.toLowerCase()
        const cur = firstLender.get(a)
        if (!cur || r.funded_at < cur) firstLender.set(a, r.funded_at)
      }
      if (r.borrower_addr) {
        const a = r.borrower_addr.toLowerCase()
        const cur = firstBorrower.get(a)
        if (!cur || r.funded_at < cur) firstBorrower.set(a, r.funded_at)
      }
    }

    type Bucket = {
      week: string
      newLenders: number
      newBorrowers: number
    }
    const buckets = new Map<string, Bucket>()

    for (const ts of firstLender.values()) {
      if (range.startISO && ts < range.startISO) continue
      if (range.endISO && ts >= range.endISO) continue
      const wk = isoWeekStart(ts)
      const b = buckets.get(wk) || { week: wk, newLenders: 0, newBorrowers: 0 }
      b.newLenders += 1
      buckets.set(wk, b)
    }
    for (const ts of firstBorrower.values()) {
      if (range.startISO && ts < range.startISO) continue
      if (range.endISO && ts >= range.endISO) continue
      const wk = isoWeekStart(ts)
      const b = buckets.get(wk) || { week: wk, newLenders: 0, newBorrowers: 0 }
      b.newBorrowers += 1
      buckets.set(wk, b)
    }

    const sorted = Array.from(buckets.values()).sort((a, b) =>
      a.week.localeCompare(b.week)
    )

    let cumulative = 0
    const points = sorted.map((b) => {
      cumulative += b.newLenders + b.newBorrowers
      return {
        week: b.week,
        newLenders: b.newLenders,
        newBorrowers: b.newBorrowers,
        cumulative,
      }
    })

    return NextResponse.json(
      { window, points },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/loans/new-wallets] error", e?.message || e)
    return NextResponse.json(
      { error: "new_wallets_failed", message: String(e?.message || e) },
      { status: 500 }
    )
  }
}
