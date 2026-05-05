// app/api/entity/pack/route.ts
// Phase 2A. Backs the EditionsGridPaginated grid on /[collection]/pack/[dist_id].
//   GET /api/entity/pack?collection=<urlSlug>&dist_id=<id>&offset=N&limit=N

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const collectionUrlSlug = url.searchParams.get("collection") ?? ""
  const distId = url.searchParams.get("dist_id") ?? ""
  const coll = getCollectionByUrlSlug(collectionUrlSlug)
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  if (!distId) return NextResponse.json({ error: "missing dist_id" }, { status: 400 })

  const offset = clamp(parseInt(url.searchParams.get("offset") ?? "0", 10), 0, 50_000)
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "100", 10), 1, 200)

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await supa.rpc("get_pack_contents", {
    p_collection_id: coll.id,
    p_dist_id: distId,
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
