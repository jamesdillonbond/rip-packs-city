// GET /api/analytics/loans/summary
//
// Aggregate KPIs for the loans dashboard. Reads flowty_loans through the
// service-role client. Empty/sparse data is returned as zeros, never NaN.
//
// Query params:
//   window      L7 | L30 | L90 | YTD | 2026 | 2025 | ALL  (default ALL)
//   collections comma-separated list (default all)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/loans-window"

export const revalidate = 600

interface LoanRow {
  funded_at: string | null
  status: string | null
  collection: string | null
  principal_usd: number | null
  principal_amount: number | null
  interest_rate: number | null
  borrower_addr: string | null
  lender_addr: string | null
}

const PAGE_SIZE = 1000

async function fetchLoans(
  startISO: string | null,
  endISO: string | null,
  collections: string[] | null
): Promise<LoanRow[]> {
  const all: LoanRow[] = []
  let from = 0
  while (true) {
    let q = supabaseAdmin
      .from("flowty_loans")
      .select(
        "funded_at,status,collection,principal_usd,principal_amount,interest_rate,borrower_addr,lender_addr"
      )
      .order("funded_at", { ascending: true, nullsFirst: false })
      .range(from, from + PAGE_SIZE - 1)
    if (collections && collections.length > 0) q = q.in("collection", collections)
    if (startISO) q = q.gte("funded_at", startISO)
    if (endISO) q = q.lt("funded_at", endISO)
    const { data, error } = await q
    if (error || !data) break
    all.push(...(data as LoanRow[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

function loanUsd(row: LoanRow): number {
  if (row.principal_usd != null) return Number(row.principal_usd) || 0
  return Number(row.principal_amount) || 0
}

function safeDelta(curr: number, prev: number): number | null {
  if (prev <= 0) return curr > 0 ? null : 0
  return Math.round(((curr - prev) / prev) * 1000) / 10
}

function summarize(rows: LoanRow[]) {
  const totalLoans = rows.length
  let totalUsd = 0
  const lenders = new Set<string>()
  const borrowers = new Set<string>()
  for (const r of rows) {
    totalUsd += loanUsd(r)
    if (r.lender_addr) lenders.add(r.lender_addr.toLowerCase())
    if (r.borrower_addr) borrowers.add(r.borrower_addr.toLowerCase())
  }
  return {
    totalLoans,
    totalUsd: Math.round(totalUsd * 100) / 100,
    uniqueLenders: lenders.size,
    uniqueBorrowers: borrowers.size,
    lenders,
    borrowers,
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const range = windowRange(window)

    // Current-window loans
    const curr = await fetchLoans(range.startISO, range.endISO, collections)

    // Prior-window loans for delta calculation
    const prev =
      range.prevStartISO && range.prevEndISO
        ? await fetchLoans(range.prevStartISO, range.prevEndISO, collections)
        : []

    // Full history of funded loans for "returning user" computation.
    // For ALL window we already have everything in `curr`; otherwise we need
    // to look at all funded_at <= window end.
    let priorAll: LoanRow[] = curr
    if (window !== "ALL") {
      priorAll = await fetchLoans(null, range.endISO, collections)
    }

    const c = summarize(curr)
    const p = summarize(prev)

    // Returning users: in current window had at least one loan in any earlier window
    const earlierLenders = new Set<string>()
    const earlierBorrowers = new Set<string>()
    if (range.startISO) {
      for (const r of priorAll) {
        if (!r.funded_at) continue
        if (r.funded_at >= range.startISO) continue
        if (r.lender_addr) earlierLenders.add(r.lender_addr.toLowerCase())
        if (r.borrower_addr) earlierBorrowers.add(r.borrower_addr.toLowerCase())
      }
    }

    let returningLenders = 0
    let returningBorrowers = 0
    for (const addr of c.lenders) if (earlierLenders.has(addr)) returningLenders++
    for (const addr of c.borrowers) if (earlierBorrowers.has(addr)) returningBorrowers++

    // First-seen wallets in current window: the set of (lender ∪ borrower)
    // whose earliest funded_at falls within the window.
    const firstSeen = new Map<string, string>() // address → earliest funded_at
    for (const r of priorAll) {
      if (!r.funded_at) continue
      if (r.lender_addr) {
        const a = r.lender_addr.toLowerCase()
        if (!firstSeen.has(a) || r.funded_at < (firstSeen.get(a) as string)) {
          firstSeen.set(a, r.funded_at)
        }
      }
      if (r.borrower_addr) {
        const a = r.borrower_addr.toLowerCase()
        if (!firstSeen.has(a) || r.funded_at < (firstSeen.get(a) as string)) {
          firstSeen.set(a, r.funded_at)
        }
      }
    }

    let newWallets = 0
    if (range.startISO && range.endISO) {
      for (const ts of firstSeen.values()) {
        if (ts >= range.startISO && ts < range.endISO) newWallets++
      }
    } else {
      newWallets = firstSeen.size
    }

    let prevNewWallets = 0
    if (range.prevStartISO && range.prevEndISO) {
      for (const ts of firstSeen.values()) {
        if (ts >= range.prevStartISO && ts < range.prevEndISO) prevNewWallets++
      }
    }

    // Live-loan strip — pulled from full table irrespective of window
    let live: { active: number; outstanding: number; avgRate: number | null; settled: number } = {
      active: 0,
      outstanding: 0,
      avgRate: null,
      settled: 0,
    }
    {
      const allRows = await fetchLoans(null, null, collections)
      const active = allRows.filter((r) => (r.status || "").toUpperCase() === "ACTIVE")
      const settled = allRows.filter((r) => (r.status || "").toUpperCase() === "SETTLED").length
      const outstanding = active.reduce((acc, r) => acc + loanUsd(r), 0)
      const ratesNumeric = allRows
        .map((r) => Number(r.interest_rate))
        .filter((n) => Number.isFinite(n) && n > 0)
      const avgRate =
        ratesNumeric.length > 0
          ? ratesNumeric.reduce((a, b) => a + b, 0) / ratesNumeric.length
          : null
      live = {
        active: active.length,
        outstanding: Math.round(outstanding * 100) / 100,
        avgRate,
        settled,
      }
    }

    const lenderRepeatPct =
      c.uniqueLenders > 0 ? Math.round((returningLenders / c.uniqueLenders) * 1000) / 10 : 0
    const borrowerRepeatPct =
      c.uniqueBorrowers > 0
        ? Math.round((returningBorrowers / c.uniqueBorrowers) * 1000) / 10
        : 0

    return NextResponse.json(
      {
        window,
        collections: collections ?? "all",
        totalLoans: c.totalLoans,
        totalUsd: c.totalUsd,
        uniqueLenders: c.uniqueLenders,
        uniqueBorrowers: c.uniqueBorrowers,
        newWallets,
        deltas: {
          totalLoansPct: safeDelta(c.totalLoans, p.totalLoans),
          totalUsdPct: safeDelta(c.totalUsd, p.totalUsd),
          uniqueLendersPct: safeDelta(c.uniqueLenders, p.uniqueLenders),
          uniqueBorrowersPct: safeDelta(c.uniqueBorrowers, p.uniqueBorrowers),
          newWalletsPct: safeDelta(newWallets, prevNewWallets),
        },
        lenderRepeatPct,
        borrowerRepeatPct,
        activeCount: live.active,
        outstandingUsd: live.outstanding,
        avgInterestRate: live.avgRate,
        settledCount: live.settled,
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/loans/summary] error", e?.message || e)
    return NextResponse.json(
      { error: "summary_failed", message: String(e?.message || e) },
      { status: 500 }
    )
  }
}
