// GET /api/analytics/sets/[set_id]
//
// Thin wrapper over analytics_sets_detail(p_set_id uuid). Returns the set
// header (collection, series, name, tier) plus the full editions list with
// FMV + confidence per edition.
//
// Validates set_id as a UUID; returns 400 for malformed input. The RPC
// raises an exception when the set doesn't exist — we surface that as 404.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SetsDetailResponse } from "@/lib/analytics-types"

export const revalidate = 600

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RouteParams {
  params: Promise<{ set_id: string }>
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const t0 = Date.now()
  const { set_id } = await params

  if (!set_id || !UUID_RE.test(set_id)) {
    return NextResponse.json({ error: "invalid_set_id" }, { status: 400 })
  }

  try {
    console.log(`[analytics/sets/detail] start set_id=${set_id}`)

    const { data, error } = await rpcWithRetry<SetsDetailResponse>(
      supabaseAdmin,
      "analytics_sets_detail",
      { p_set_id: set_id }
    )

    if (error) {
      // Postgres RAISE EXCEPTION lands here. The RPC contract uses the message
      // text "set not found" for missing rows.
      const msg = (error.message || "").toLowerCase()
      if (msg.includes("not found") || msg.includes("does not exist")) {
        console.log("[analytics/sets/detail] not_found", set_id)
        return NextResponse.json({ error: "set_not_found" }, { status: 404 })
      }
      console.log("[analytics/sets/detail] rpc_error", error.message)
      return NextResponse.json({ error: "sets_detail_failed" }, { status: 500 })
    }

    if (!data) {
      return NextResponse.json({ error: "set_not_found" }, { status: 404 })
    }

    console.log(`[analytics/sets/detail] ok elapsed=${Date.now() - t0}ms`)

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[analytics/sets/detail] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "sets_detail_failed" }, { status: 500 })
  }
}
