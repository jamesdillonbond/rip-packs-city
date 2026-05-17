// app/api/pack-simulator/route.ts
//
// GET /api/pack-simulator?collectionId=<uuid>&distId=<text>
//
// Thin wrapper over the get_pack_for_simulator(p_collection_id uuid, p_dist_id text)
// RPC. Returns the RPC payload as-is — { pack, pool, metrics, note, computed_at }
// on hit, { error: 'pack not found', dist_id } on miss. The pool array carries
// drop_weight + hit_probability for client-side Monte Carlo sampling; the RPC
// excludes exhausted (remaining=0) editions and re-normalizes probabilities
// to sum to 1.0 across the surviving pool.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const collectionId = url.searchParams.get("collectionId") ?? ""
  const distId = url.searchParams.get("distId") ?? ""

  if (!collectionId || !distId) {
    return NextResponse.json(
      { error: "collectionId and distId are required" },
      { status: 400 },
    )
  }

  try {
    const { data, error } = await sb.rpc("get_pack_for_simulator", {
      p_collection_id: collectionId,
      p_dist_id: distId,
    })
    if (error) {
      console.error("[pack-simulator]", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data ?? { error: "pack not found", dist_id: distId }, {
      headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[pack-simulator] unexpected", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
