// app/api/entity/team-checklist-progress/route.ts
// Team Hub Phase 2 (C4). Backs the TeamChecklist progress header on
// /[collection]/team/[slug] via get_team_checklist_progress. Returns totals,
// completion %, cost-to-complete at floor, per-tier breakdown, and a
// wallet_cached signal the component uses to decide whether to fire a backfill.
//   GET /api/entity/team-checklist-progress?collection=<urlSlug>&slug=<teamSlug>
//        &scope=<all_time|contemporary|series_N>&wallet=<0x.. | base58 on a Solana collection>
//
// Read-only. Anon-visible (proxy.ts opens GET /api/entity/*); the no-wallet
// number is the public full-checklist acquisition cost.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { getCollection } from "@/lib/collections"
import { parseChecklistWallet } from "@/lib/entity/checklist-wallet"

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

  // Parsed for the collection's own chain: a Solana key passes VERBATIM, a
  // wrong-chain key on a Solana collection is refused (lib/entity/checklist-wallet.ts).
  const parsed = parseChecklistWallet(url.searchParams.get("wallet"), getCollection(collectionUrlSlug)?.dbChain)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const wallet = parsed.wallet

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await boundedRead(supa.rpc("get_team_checklist_progress", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_scope: scope,
    p_wallet: wallet,
  }), "api/entity/team-checklist-progress/get_team_checklist_progress")
  if (error) return apiErrorResponse(error, "api/entity/team-checklist-progress")
  return NextResponse.json(data ?? {})
}
