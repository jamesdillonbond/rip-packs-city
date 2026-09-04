// app/api/entity/edition/route.ts
// Phase 1B. Backs the client-side FmvHistoryChart and SalesTablePaginated
// components. Wraps two RPCs: get_edition_fmv_history and get_edition_recent_sales.
//
//   GET /api/entity/edition?collection=<urlSlug>&slug=<routeSlug>&part=fmv-history&days=N
//   GET /api/entity/edition?collection=<urlSlug>&slug=<routeSlug>&part=sales&offset=N&limit=N
//   GET /api/entity/edition?collection=<urlSlug>&editionKey=<external_id>&part=bio

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const collectionUrlSlug = url.searchParams.get("collection") ?? ""
  const routeSlug = url.searchParams.get("slug") ?? ""
  const part = url.searchParams.get("part") ?? ""

  const coll = getCollectionByUrlSlug(collectionUrlSlug)
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })

  // ── part=bio ────────────────────────────────────────────────────────────
  // The three player-bio facts `classifySerial` needs for its jersey_match /
  // birthday_match / draft_year_match quirks. Keyed on `editionKey` rather
  // than the route slug used by every other part, because `editions.external_id`
  // IS the edition key and the two are not interchangeable (`get_edition_detail`
  // returns `route_slug` and `external_id` as separate fields).
  //
  // ⚠ NOT a price surface. These are catalog facts that change roughly never,
  // hence the long cache; a bio read must never be on the critical path of
  // anything a collector reads as a number.
  if (part === "bio") {
    const editionKey = url.searchParams.get("editionKey") ?? ""
    if (!editionKey) return NextResponse.json({ error: "missing editionKey" }, { status: 400 })

    const db = supabaseAdmin as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (c: string, v: unknown) => {
            eq: (c: string, v: unknown) => {
              maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>
            }
          }
        }
      }
    }
    const { data, error } = await boundedRead(db
      .from("editions")
      .select("jersey_number, player_birthdate, player_draft_year")
      .eq("collection_id", coll.id)
      .eq("external_id", editionKey)
      .maybeSingle(), "api/entity/edition/editions")

    // A failed READ is an error, never an answer — three all-null fields would
    // be indistinguishable from an edition we genuinely hold no bio for, and
    // the caller renders the difference as "fewer chips" either way. Let the
    // classified error through so the caller can tell the two apart.
    if (error) return apiErrorResponse(error, "api/entity/edition")

    // An absent row IS a real answer (Pinnacle lives in `pinnacle_editions`,
    // and only Top Shot has a bio source at all), so it is a 200 with nulls.
    return NextResponse.json(
      {
        jerseyNumber: data?.jersey_number == null ? null : Number(data.jersey_number),
        birthdate: typeof data?.player_birthdate === "string" ? data.player_birthdate : null,
        draftYear: data?.player_draft_year == null ? null : Number(data.player_draft_year),
      },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    )
  }

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
