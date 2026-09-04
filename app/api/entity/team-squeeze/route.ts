// app/api/entity/team-squeeze/route.ts
// Team Hub Phase 3 (C7). Team slice of the Top Shot squeeze board (lock+burn
// effective-supply ranking), via get_team_squeeze. Returns [] for non-Top-Shot
// collections (the board is TS-only), so the section self-hides. Mirrors
// team-editions/route.ts.
//   GET /api/entity/team-squeeze?collection=<urlSlug>&slug=<teamSlug>&limit=N
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

  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "12", 10), 1, 50)

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await boundedRead(supa.rpc("get_team_squeeze", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_limit: limit,
  }), "api/entity/team-squeeze/get_team_squeeze")
  if (error) return apiErrorResponse(error, "api/entity/team-squeeze")
  return NextResponse.json(data ?? [])
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
