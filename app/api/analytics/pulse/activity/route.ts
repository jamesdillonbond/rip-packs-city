// GET /api/analytics/pulse/activity
//
// Thin wrapper over analytics_pulse_activity(p_collections, p_kinds,
// p_since, p_limit). Each row is one event (loan origination,
// loan repayment, loan settlement, or sale) ordered desc by occurred_at.
//
// Query params:
//   collections  comma-separated list                              (optional)
//   kinds        comma-separated subset of loan_originated|loan_repaid|
//                loan_settled|sale                                 (optional)
//   since        ISO timestamp; only return events after this      (optional)
//   limit        default 50, max 200                               (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { PulseActivityRow } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 30

const ALLOWED_KINDS = new Set(["loan_originated", "loan_repaid", "loan_settled", "sale"])

function parseKinds(raw: string | null): string[] | null {
  if (!raw) return null
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ALLOWED_KINDS.has(s))
  return list.length > 0 ? list : null
}

function parseLimit(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 50
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(200, Math.max(1, n))
}

function parseSince(raw: string | null): string | null {
  if (!raw) return null
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString()
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))
    const kinds = parseKinds(url.searchParams.get("kinds"))
    const since = parseSince(url.searchParams.get("since"))
    const limit = parseLimit(url.searchParams.get("limit"))

    console.log(
      `[analytics/pulse/activity] start collections=${collections?.join(",") ?? "all"} kinds=${kinds?.join(",") ?? "all"} since=${since ?? "null"} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<PulseActivityRow[]>(
      supabaseAdmin,
      "analytics_pulse_activity",
      {
        p_collections: collections,
        p_kinds: kinds,
        p_since: since,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/pulse/activity] rpc_error", error.message)
      return NextResponse.json({ error: "pulse_activity_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as PulseActivityRow[]
    console.log(
      `[analytics/pulse/activity] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/pulse/activity] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "pulse_activity_failed" }, { status: 500 })
  }
}
