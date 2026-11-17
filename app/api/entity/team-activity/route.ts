// app/api/entity/team-activity/route.ts
// Team Hub Phase 3 (C7). Recent team sales (sales -> editions) for the team page
// Market Activity section, via get_team_activity. Mirrors team-editions/route.ts.
//   GET /api/entity/team-activity?collection=<urlSlug>&slug=<teamSlug>&offset=N&limit=N
// Read-only; proxy.ts already opens GET /api/entity/* to anon.

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
  const teamSlug = url.searchParams.get("slug") ?? ""
  const coll = getCollectionByUrlSlug(collectionUrlSlug)
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  if (!teamSlug) return NextResponse.json({ error: "missing slug" }, { status: 400 })

  const offset = clamp(parseInt(url.searchParams.get("offset") ?? "0", 10), 0, 50_000)
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "30", 10), 1, 100)

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await boundedRead(supa.rpc("get_team_activity", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_limit: limit,
    p_offset: offset,
  }), "api/entity/team-activity/get_team_activity")
  if (error) return apiErrorResponse(error, "api/entity/team-activity")
  return NextResponse.json(data ?? [])
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
