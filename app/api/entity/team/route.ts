// app/api/entity/team/route.ts
// Phase 1E. Backs the PlayersGridPaginated grid on /[collection]/team/[slug].
//   GET /api/entity/team?collection=<urlSlug>&slug=<teamSlug>&offset=N&limit=N

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"

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
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "100", 10), 1, 200)

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await supa.rpc("get_team_players", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
