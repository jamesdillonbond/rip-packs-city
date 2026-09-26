// app/api/entity/edition-badges/route.ts
// Backs the Badge filter on the player page's EditionsGridPaginated grid.
//   POST /api/entity/edition-badges  { collection: <urlSlug>, slugs: string[] }
//   → { badges: Record<route_slug, string[]> }
//
// Badge titles come from get_edition_badge_titles, which runs the canonical
// per-edition get_edition_badges_unified — the same badges the edition page
// shows. A slug with no badges maps to [] (known none); a slug the DB does not
// know is ABSENT (unknown) — callers must not read absence as "no badges".
// ⚠ A read failure is a 5xx via apiErrorResponse, never `{ badges: {} }`,
// which would render every edition as badge-less.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_SLUGS = 500

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const { collection, slugs } = (body ?? {}) as { collection?: unknown; slugs?: unknown }
  const coll = typeof collection === "string" ? getCollectionByUrlSlug(collection) : null
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  if (!Array.isArray(slugs)) return NextResponse.json({ error: "slugs must be an array" }, { status: 400 })
  const clean = [...new Set(slugs.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 200))]
  if (clean.length > MAX_SLUGS) return NextResponse.json({ error: `at most ${MAX_SLUGS} slugs` }, { status: 400 })
  if (clean.length === 0) return NextResponse.json({ badges: {} })

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await boundedRead(supa.rpc("get_edition_badge_titles", {
    p_collection_id: coll.id,
    p_route_slugs: clean,
  }), "api/entity/edition-badges/get_edition_badge_titles")
  if (error) return apiErrorResponse(error, "api/entity/edition-badges")
  const badges = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, string[]>) : {}
  return NextResponse.json({ badges }, { headers: { "Cache-Control": "public, max-age=300" } })
}
