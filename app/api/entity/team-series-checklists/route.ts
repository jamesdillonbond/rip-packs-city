// app/api/entity/team-series-checklists/route.ts
// Team Series Checklists (2026-11-23): per series, one Moment of every franchise player.
// Backs components/entity/TeamSeriesChecklists.tsx via get_team_series_checklists
// (migration 20261124032715; lib/entity/team-series-checklists.ts).
//   GET /api/entity/team-series-checklists?collection=<urlSlug>&slug=<teamSlug>&wallet=<0x.. | base58 on a Solana collection>
//
// Read-only. Anon-visible (proxy.ts opens GET /api/entity/*); without a wallet it is the
// public roster + full cost per series.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { getCollection } from "@/lib/collections"
import { parseChecklistWallet } from "@/lib/entity/checklist-wallet"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const collectionUrlSlug = url.searchParams.get("collection") ?? ""
  const teamSlug = url.searchParams.get("slug") ?? ""
  const coll = getCollectionByUrlSlug(collectionUrlSlug)
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  if (!teamSlug) return NextResponse.json({ error: "missing slug" }, { status: 400 })

  const parsed = parseChecklistWallet(url.searchParams.get("wallet"), getCollection(collectionUrlSlug)?.dbChain)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await boundedRead(supa.rpc("get_team_series_checklists", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_wallet: parsed.wallet,
  }), "api/entity/team-series-checklists")
  if (error) return apiErrorResponse(error, "api/entity/team-series-checklists")
  return NextResponse.json(data ?? { wallet_cached: null, series: [] })
}
