import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

// GET /api/moment/[id]
//
// Public, no auth. Resolves [id] as one of:
//   - flow nft_id (numeric, serial-specific moment)
//   - moment uuid (serial-specific moment, NFT row)
//   - edition uuid (edition aggregate, no specific serial)
//
// Backed by the SECDEF RPC public.get_moment_detail(p_id text), which
// returns a single JSONB payload aggregating editions + serial state +
// fmv + recent sales + similar editions. Both this route and the
// server-side page at /moment/[id] use the same RPC; we expose the API
// shape for client-side fetches and external embedding.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type MomentDetail = {
  ok: boolean
  error?: string
  input?: string
  resolved?: unknown
  edition?: unknown
  fmv?: unknown
  serial_specific?: unknown
  recent_sales?: unknown
  similar_editions?: unknown
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "missing_id" },
      { status: 400 }
    )
  }

  const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_moment_detail", {
    p_id: id,
  }), "api/moment/[id]/get_moment_detail")

  if (error) {
    // Deliberately NOT `{ ok: false, ... }`: this route's `ok: false` is the
    // RPC's own "no such moment" verdict (returned at 404 below), so reusing it
    // for a database failure makes a lookup outage indistinguishable from a
    // genuine miss — the same conflation the callers were already making.
    return apiErrorResponse(error, "api/moment", "Moment lookup isn't available right now.")
  }

  const payload = (data ?? { ok: false, error: "not_found", input: id }) as MomentDetail

  if (payload.ok === false) {
    return NextResponse.json(payload, { status: 404 })
  }

  return NextResponse.json(payload, {
    headers: { "cache-control": "public, max-age=60, stale-while-revalidate=300" },
  })
}
