// GET /api/analytics/loans/timeseries
//
// Daily (or weekly when span > 90 days) buckets of loan volume,
// stacked by collection. Used by the volume area chart.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/loans-window"

export const revalidate = 600

interface Row {
  funded_at: string | null
  collection: string | null
  principal_usd: number | null
  principal_amount: number | null
}

const PAGE_SIZE = 1000
const DAY_MS = 24 * 60 * 60 * 1000

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
      .select("funded_at,collection,principal_usd,principal_amount")
      .not("funded_at", "is", null)
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

function bucketKey(iso: string, weekly: boolean): string {
  const d = new Date(iso)
  if (weekly) {
    // ISO week starting Monday — round down to start of week.
    const day = d.getUTCDay() || 7
    const start = new Date(d)
    start.setUTCDate(d.getUTCDate() - day + 1)
    return start.toISOString().slice(0, 10)
  }
  return iso.slice(0, 10)
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const range = windowRange(window)

    const rows = await fetchAll(range.startISO, range.endISO, collections)

    if (rows.length === 0) {
      return NextResponse.json(
        { window, points: [], collections: [], weekly: false },
        {
          headers: {
            "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
          },
        }
      )
    }

    // Decide weekly vs daily based on span
    const first = rows[0].funded_at as string
    const last = rows[rows.length - 1].funded_at as string
    const spanDays = (new Date(last).getTime() - new Date(first).getTime()) / DAY_MS
    const weekly = spanDays > 90

    const buckets = new Map<
      string,
      { date: string; totalUsd: number; totalLoans: number; perCol: Record<string, number> }
    >()
    const collectionsSeen = new Set<string>()
    for (const r of rows) {
      if (!r.funded_at) continue
      const key = bucketKey(r.funded_at, weekly)
      const usd = Number(r.principal_usd ?? r.principal_amount ?? 0) || 0
      const col = (r.collection || "unknown").toLowerCase()
      collectionsSeen.add(col)
      const b = buckets.get(key) || {
        date: key,
        totalUsd: 0,
        totalLoans: 0,
        perCol: {},
      }
      b.totalUsd += usd
      b.totalLoans += 1
      b.perCol[col] = (b.perCol[col] || 0) + usd
      buckets.set(key, b)
    }

    const points = Array.from(buckets.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((b) => ({
        date: b.date,
        totalUsd: Math.round(b.totalUsd * 100) / 100,
        totalLoans: b.totalLoans,
        ...Object.fromEntries(
          Array.from(collectionsSeen).map((c) => [c, Math.round((b.perCol[c] || 0) * 100) / 100])
        ),
      }))

    return NextResponse.json(
      {
        window,
        weekly,
        collections: Array.from(collectionsSeen).sort(),
        points,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/loans/timeseries] error", e?.message || e)
    return NextResponse.json(
      { error: "timeseries_failed", message: String(e?.message || e) },
      { status: 500 }
    )
  }
}
