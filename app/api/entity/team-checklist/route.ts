// app/api/entity/team-checklist/route.ts
// Team Hub Phase 2 (C4). Backs the TeamChecklist edition grid on
// /[collection]/team/[slug] via get_team_checklist (clone of get_team_top_editions
// + scope filter + wallet ownership). Mirrors team-editions/route.ts.
//   GET /api/entity/team-checklist?collection=<urlSlug>&slug=<teamSlug>
//        &scope=<all_time|contemporary|series_N>&wallet=<0x..>&offset=N&limit=N
//
// Read-only catalog read. proxy.ts already opens GET /api/entity/* to anon, so
// the public (no-wallet) checklist is anon-visible for SEO; passing wallet adds
// owned-vs-missing flags from wallet_moments_cache.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SCOPE_RE = /^(all_time|contemporary|series_\d+)$/

export async function GET(req: Request) {
  const url = new URL(req.url)
  const collectionUrlSlug = url.searchParams.get("collection") ?? ""
  const teamSlug = url.searchParams.get("slug") ?? ""
  const coll = getCollectionByUrlSlug(collectionUrlSlug)
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })
  if (!teamSlug) return NextResponse.json({ error: "missing slug" }, { status: 400 })

  const rawScope = url.searchParams.get("scope") ?? "all_time"
  const scope = SCOPE_RE.test(rawScope) ? rawScope : "all_time"

  const rawWallet = (url.searchParams.get("wallet") ?? "").trim().toLowerCase()
  const wallet = /^0x[0-9a-f]{16}$/.test(rawWallet) ? rawWallet : null

  const offset = clamp(parseInt(url.searchParams.get("offset") ?? "0", 10), 0, 50_000)
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "60", 10), 1, 200)

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await supa.rpc("get_team_checklist", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_scope: scope,
    p_wallet: wallet,
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
