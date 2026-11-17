// app/api/entity/edition-badges/route.ts
// Backs the Badge filter on the player page's EditionsGridPaginated grid.
//   GET /api/entity/edition-badges?collection=<urlSlug>&slugs=<a,b,c>
//   → { badges: Record<route_slug, string[]> }
//
// ⚠ GET, NOT POST (2026-09-25): proxy.ts makes /api/entity/* public for
// GET/HEAD only — every route under it is a read. This route first shipped as a
// POST and every SIGNED-OUT reader got a 401 from the proxy (3 of 3 live calls),
// while a signed-in reader saw it work. A read belongs on GET anyway.
//
// Badge titles come from get_edition_badge_titles, which runs the canonical
// per-edition get_edition_badges_unified — the same badges the edition page
// shows. A slug with no badges maps to [] (known none); a slug the DB does not
// know is ABSENT (unknown) — callers must not read absence as "no badges".
// ⚠ A read failure is a 5xx via apiErrorResponse, never `{ badges: {} }`,
// which would render every edition as badge-less.
//
// Slugs are comma-joined: no editions.external_id contains a comma (0 of
// 26,962, max length 67, measured 2026-09-25), and MAX_SLUGS keeps the URL
// under ~7 KB even at that worst-case length.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_SLUGS = 100

export async function GET(req: Request) {
  const url = new URL(req.url)
  const coll = getCollectionByUrlSlug(url.searchParams.get("collection") ?? "")
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  const raw = url.searchParams.get("slugs")
  if (raw == null) return NextResponse.json({ error: "missing slugs" }, { status: 400 })
  const clean = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 200))]
  if (clean.length > MAX_SLUGS) return NextResponse.json({ error: `at most ${MAX_SLUGS} slugs` }, { status: 400 })
  if (clean.length === 0) return NextResponse.json({ badges: {} })

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await boundedRead(supa.rpc("get_edition_badge_titles", {
    p_collection_id: coll.id,
    p_route_slugs: clean,
  }), "api/entity/edition-badges/get_edition_badge_titles")
  if (error) return apiErrorResponse(error, "api/entity/edition-badges")
  // ⚠ A result of the wrong shape is a 502, never `{badges:{}}` — an empty map
  // is a success the client would cache as "these slugs have no answer", with
  // no failure line and no retry (same rule as /api/wallet/edition-counts).
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return NextResponse.json({ error: "unexpected edition-badges shape" }, { status: 502, headers: { "Cache-Control": "no-store" } })
  }
  const badges = data as Record<string, string[]>
  // Badges change on a sync cadence of hours; a short shared cache is safe and
  // spares the DB repeat reads of the same player's grid.
  return NextResponse.json({ badges }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } })
}
