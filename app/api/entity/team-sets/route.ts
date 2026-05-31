// app/api/entity/team-sets/route.ts
// Team Hub Phase 3 (C7). Sets featuring the team (counts + cheapest entry, plus
// owned-per-set when a wallet is supplied), via get_team_sets. Mirrors
// team-editions/route.ts.
//   GET /api/entity/team-sets?collection=<urlSlug>&slug=<teamSlug>&wallet=<0x..>
// Read-only; proxy.ts already opens GET /api/entity/* to anon.

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

  const rawWallet = (url.searchParams.get("wallet") ?? "").trim().toLowerCase()
  const wallet = /^0x[0-9a-f]{16}$/.test(rawWallet) ? rawWallet : null

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await supa.rpc("get_team_sets", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_wallet: wallet,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
