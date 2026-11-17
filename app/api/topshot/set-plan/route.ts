// app/api/topshot/set-plan/route.ts
//
// Bulk-buy planner endpoint — "what would it cost to Quick-Buy the rest of this
// Top Shot set at floor, and what's it worth?". Reads the read-side planner RPC
// get_topshot_set_completion_plan (badge_editions.low_ask floor + fmv_snapshots
// FMV per missing play, minus the wallet's wmc ownership). In-app bulk EXECUTION
// is blocked by the Dapper co-signer wall (see the bulk-purchasing research doc);
// this is the intelligence surface that IS buildable.
//
// GET /api/topshot/set-plan?setId=<uuid>[&wallet=0x…][&limit=400]
//
// Each missing play is enriched with an in-product deep link to our own edition
// page (which carries the live "View Listing" out to Top Shot). We deliberately
// don't fabricate a Top Shot listing deep link: the floor is an aggregate and
// doesn't carry the specific cheapest listing's moment id.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface MissingPlay {
  external_id: string
  play_id_onchain: number | null
  player_name: string | null
  tier: string | null
  thumbnail_url: string | null
  fmv_usd: number | null
  low_ask: number | null
  has_listing: boolean
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const setId = (searchParams.get("setId") ?? "").trim()
  const wallet = (searchParams.get("wallet") ?? "").trim()
  const limitRaw = Number(searchParams.get("limit") ?? "400")
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000) : 400

  if (!UUID_RE.test(setId)) {
    return NextResponse.json({ error: "setId must be a set UUID" }, { status: 400 })
  }

  try {
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_topshot_set_completion_plan", {
      p_wallet: wallet,
      p_set_id: setId,
      p_limit: limit,
    }), "api/topshot/set-plan/get_topshot_set_completion_plan")
    if (error) {
      return apiErrorResponse(error, "api/topshot/set-plan");
    }
    if (!data || !data.set_name) {
      return NextResponse.json({ error: "set not found" }, { status: 404 })
    }

    // Enrich missing plays with an in-product deep link (edition page → View Listing).
    const missing: MissingPlay[] = Array.isArray(data.missing) ? data.missing : []
    const enriched = missing.map((m) => ({
      ...m,
      // value gap: positive = floor is below FMV (buying to complete is +EV)
      value_gap:
        typeof m.fmv_usd === "number" && typeof m.low_ask === "number"
          ? Math.round((m.fmv_usd - m.low_ask) * 100) / 100
          : null,
      edition_url: `/nba-top-shot/edition/${encodeURIComponent(m.external_id)}`,
    }))

    return NextResponse.json({ ...data, missing: enriched }, { status: 200 })
  } catch (e) {
    return apiErrorResponse(e, "api/topshot/set-plan");
  }
}
