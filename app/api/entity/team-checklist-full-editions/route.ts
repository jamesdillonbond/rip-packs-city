// app/api/entity/team-checklist-full-editions/route.ts
// Backs the TeamChecklist "Full editions" view on /[collection]/team/[slug]
// (Trevor, 2026-09-30, replacing the 09-29 "Ignore parallels" play grouping). In
// that view the checklist is read at the FULL EDITION level: subedition
// parallels are removed, and the header — total, owned, %, cost-to-complete,
// per-tier — counts full editions only, each owned and priced on its own.
//
//   GET /api/entity/team-checklist-full-editions?collection=<urlSlug>&slug=<teamSlug>
//        &scope=<all_time|contemporary|series_N>&wallet=<0x.. | base58 on a Solana collection>
//     → { has_parallels, progress: FullEditionProgress & { wallet_cached, scope }, editions: FullEditionTile[] }
//   GET /api/entity/team-checklist-full-editions?collection=<urlSlug>&probe=1
//     → { has_parallels } — does this collection carry ANY parallel edition key?
//       The component shows the toggle only when it does (derived from data,
//       never a slug list).
//
// Filtering + pricing live in lib/entity/checklist-full-editions.ts (pure,
// tested). This route reads the COMPLETE scoped checklist from the same RPC the
// tile grid uses (get_team_checklist, 200 per page) — the header is only correct
// over the whole list, so a partial read is REFUSED: every page error fails the
// request, and the distinct keys read must equal the edition total
// get_team_checklist_progress reports (the RPC's order has no unique tiebreak,
// so an offset walk could in principle skip a row; the count check catches it).
//
// Read-only; anon-visible like the other GET /api/entity/* routes.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { getCollection } from "@/lib/collections"
import { parseChecklistWallet } from "@/lib/entity/checklist-wallet"
import {
  checklistHasParallels,
  computeFullEditionProgress,
  fullEditionTiles,
  type ChecklistEditionRow,
} from "@/lib/entity/checklist-full-editions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// One progress read + up to a few 8 s-bounded pages, sequential.
export const maxDuration = 60

const SCOPE_RE = /^(all_time|contemporary|series_\d+)$/
const PAGE = 200
// 10 × 200 = 2,000 editions; the largest Top Shot team is ~500 (2026-09-29).
// Reaching the cap without a short page means the list is not known complete.
const MAX_PAGES = 10

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }

export async function GET(req: Request) {
  const url = new URL(req.url)
  const collectionUrlSlug = url.searchParams.get("collection") ?? ""
  const coll = getCollectionByUrlSlug(collectionUrlSlug)
  if (!coll) return NextResponse.json({ error: "unknown collection" }, { status: 404 })

  if (url.searchParams.get("probe") === "1") {
    const { data, error } = await boundedRead(
      supabaseAdmin.from("editions").select("external_id").eq("collection_id", coll.id).like("external_id", "%::%").limit(1),
      "api/entity/team-checklist-full-editions/probe",
    )
    if (error) return apiErrorResponse(error, "api/entity/team-checklist-full-editions")
    return NextResponse.json({ has_parallels: Array.isArray(data) && data.length > 0 })
  }

  const teamSlug = url.searchParams.get("slug") ?? ""
  if (!teamSlug) return NextResponse.json({ error: "missing slug" }, { status: 400 })

  const rawScope = url.searchParams.get("scope") ?? "all_time"
  const scope = SCOPE_RE.test(rawScope) ? rawScope : "all_time"

  const parsed = parseChecklistWallet(url.searchParams.get("wallet"), getCollection(collectionUrlSlug)?.dbChain)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const wallet = parsed.wallet

  const supa = supabaseAdmin as unknown as Rpc

  // The edition total the walk must reproduce, and the wallet_cached signal the
  // component's first-paste indexing flow keys on.
  const { data: progData, error: progError } = await boundedRead(supa.rpc("get_team_checklist_progress", {
    p_collection_id: coll.id,
    p_team_slug: teamSlug,
    p_scope: scope,
    p_wallet: wallet,
  }), "api/entity/team-checklist-full-editions/get_team_checklist_progress")
  if (progError) return apiErrorResponse(progError, "api/entity/team-checklist-full-editions")
  const prog = (progData ?? {}) as { total?: unknown; wallet_cached?: unknown }
  const expectedTotal = typeof prog.total === "number" ? prog.total : null
  if (expectedTotal == null) {
    return apiErrorResponse({ message: "team checklist progress returned no edition total" }, "api/entity/team-checklist-full-editions")
  }

  const byKey = new Map<string, ChecklistEditionRow>()
  let complete = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await boundedRead(supa.rpc("get_team_checklist", {
      p_collection_id: coll.id,
      p_team_slug: teamSlug,
      p_scope: scope,
      p_wallet: wallet,
      p_limit: PAGE,
      p_offset: page * PAGE,
    }), "api/entity/team-checklist-full-editions/get_team_checklist")
    // A failed page fails the request — grouping a partial list would publish
    // a play count and cost that no caller could tell from the real one.
    if (error) return apiErrorResponse(error, "api/entity/team-checklist-full-editions")
    const rows = Array.isArray(data) ? (data as ChecklistEditionRow[]) : []
    for (const r of rows) {
      if (r && typeof r.route_slug === "string") byKey.set(r.route_slug, r)
    }
    if (rows.length < PAGE) { complete = true; break }
  }
  if (!complete || byKey.size !== expectedTotal) {
    return apiErrorResponse(
      { message: `team checklist read incomplete: ${byKey.size} of ${expectedTotal} editions` },
      "api/entity/team-checklist-full-editions",
    )
  }

  const editions = [...byKey.values()]
  const hasWallet = wallet != null
  const tiles = fullEditionTiles(editions, hasWallet)
  const progress = computeFullEditionProgress(tiles, hasWallet)
  return NextResponse.json({
    has_parallels: checklistHasParallels(editions),
    progress: { ...progress, wallet_cached: prog.wallet_cached === true, scope },
    editions: tiles,
  })
}
