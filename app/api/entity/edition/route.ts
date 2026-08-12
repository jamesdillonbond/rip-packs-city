// app/api/entity/edition/route.ts
// Phase 1B. Backs the client-side FmvHistoryChart and SalesTablePaginated
// components. Wraps two RPCs: get_edition_fmv_history and get_edition_recent_sales.
//
//   GET /api/entity/edition?collection=<urlSlug>&slug=<routeSlug>&part=fmv-history&days=N
//   GET /api/entity/edition?collection=<urlSlug>&slug=<routeSlug>&part=sales&offset=N&limit=N

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { apiErrorResponse } from "@/lib/api-error"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const collectionUrlSlug = url.searchParams.get("collection") ?? ""
  const routeSlug = url.searchParams.get("slug") ?? ""
  const part = url.searchParams.get("part") ?? ""

  const coll = getCollectionByUrlSlug(collectionUrlSlug)
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  if (!routeSlug) return NextResponse.json({ error: "missing slug" }, { status: 400 })

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }

  if (part === "fmv-history") {
    const days = clamp(parseInt(url.searchParams.get("days") ?? "30", 10), 7, 365)
    const { data, error } = await supa.rpc("get_edition_fmv_history", {
      p_collection_id: coll.id,
      p_route_slug: routeSlug,
      p_days: days,
    })
    if (error) return apiErrorResponse(error, "api/entity/edition")
    return NextResponse.json(data ?? [])
  }

  // Sale-print history — the LONG-horizon series. Distinct from fmv-history
  // because `fmv_snapshots` only starts 2026-03-31 (~4.5 months), so a 1-year
  // or all-time FMV chart cannot exist; `sales` goes back to 2020-07-28. Rows
  // carry their own `grain` (day/week/month, chosen from the window) so the
  // caller can label the axis honestly instead of implying daily resolution on
  // a six-year chart. days=0 means all time — hence the 0 floor on the clamp.
  if (part === "sale-history") {
    const days = clamp(parseInt(url.searchParams.get("days") ?? "365", 10), 0, 4000)
    const { data, error } = await supa.rpc("get_edition_sale_history", {
      p_collection_id: coll.id,
      p_route_slug: routeSlug,
      p_days: days,
    })
    if (error) return apiErrorResponse(error, "api/entity/edition")
    return NextResponse.json(data ?? [])
  }

  if (part === "sales") {
    const offset = clamp(parseInt(url.searchParams.get("offset") ?? "0", 10), 0, 10_000)
    const limit = clamp(parseInt(url.searchParams.get("limit") ?? "30", 10), 1, 100)
    const { data, error } = await supa.rpc("get_edition_recent_sales", {
      p_collection_id: coll.id,
      p_route_slug: routeSlug,
      p_limit: limit,
      p_offset: offset,
    })
    if (error) return apiErrorResponse(error, "api/entity/edition")
    return NextResponse.json(data ?? [])
  }

  return NextResponse.json({ error: "unknown part" }, { status: 400 })
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
