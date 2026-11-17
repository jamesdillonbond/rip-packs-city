// app/api/profile/trophy/fill/route.ts
//
// POST { confirm?: boolean } → "Fill with my top 6" for the signed-in member's
// MAIN trophy case (2026-11-16; see lib/trophy/fill-main.ts for why). Without
// `confirm` it PROPOSES pieces for the empty slots and writes nothing; with
// `confirm: true` it pins them.
//
// ⚠ Candidates are the trophy picker's own list (get_user_top_owned_moments), so
//   the fill offers nothing the member could not pin by hand. Panini cards are
//   left out: a Panini pin is verified one card at a time against a linked
//   username (lib/trophy/panini-card.ts), which this bulk path does not do.
// ⚠ Only EMPTY slots are written (ignoreDuplicates on the NULLS NOT DISTINCT
//   (user_id, case_id, slot) key), so a fill never displaces a pin.
// ⚠ `pinned` counts rows the upsert RETURNED, not rows attempted. A failed read is
//   an error status via apiErrorResponse, never an empty proposal.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { sanitizeTrophyThumbnail } from "@/lib/profile/trophy-thumbnail"
import { logTrophyFunnelEvent } from "@/lib/trophy/funnel-event"
import { warmCardsLater } from "@/lib/og/card-warm"
import { chooseMainFillPicks, freeMainSlots, type MainFillCandidate } from "@/lib/trophy/fill-main"

export const dynamic = "force-dynamic"

const ROUTE = "api/profile/trophy/fill"
const CANDIDATE_LIMIT = 48

function fmvNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  const body = await req.json().catch(() => null)
  const confirm = body?.confirm === true

  const caseRes = await boundedRead(
    supabase.from("trophy_moments").select("slot, moment_id, edition_id").eq("user_id", user.id).is("case_id", null),
    `${ROUTE}/main-case`,
  )
  if (caseRes.error) return apiErrorResponse(caseRes.error, ROUTE)
  const inCase = (caseRes.data ?? []) as unknown as { slot: number; moment_id: string; edition_id: string | null }[]
  const free = freeMainSlots(inCase.map((p) => p.slot))
  if (free.length === 0) return NextResponse.json({ need: 0, picks: [], short: 0, pinned: 0 })

  const candRes = await boundedRead(
    supabase.rpc("get_user_top_owned_moments", { p_user_id: user.id, p_limit: CANDIDATE_LIMIT }),
    `${ROUTE}/candidates`,
  )
  if (candRes.error) return apiErrorResponse(candRes.error, ROUTE, "Couldn't read your collection right now — try again in a moment.")
  const panini = COLLECTION_UUID_BY_SLUG["panini-blockchain"]
  const candidates = ((candRes.data ?? []) as unknown as MainFillCandidate[]).filter(
    (r) => r && r.moment_id && r.collection_id && r.collection_id !== panini,
  )

  const picks = chooseMainFillPicks(candidates, {
    freeSlots: free,
    pinnedMomentIds: new Set(inCase.map((p) => String(p.moment_id))),
    pinnedEditions: new Set(inCase.map((p) => p.edition_id).filter((e): e is string => !!e)),
  })
  const short = free.length - picks.length
  const proposal = picks.map((p) => ({
    slot: p.slot,
    moment_id: String(p.moment_id),
    player_name: p.player_name,
    set_name: p.set_name,
    tier: p.tier,
    serial_number: p.serial_number,
    fmv: fmvNum(p.fmv_usd),
  }))
  if (!confirm) return NextResponse.json({ need: free.length, picks: proposal, short })
  if (picks.length === 0) return NextResponse.json({ need: free.length, picks: [], short, pinned: 0 })

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("trophy_moments")
    .upsert(
      picks.map((p) => ({
        user_id: user.id,
        case_id: null,
        slot: p.slot,
        moment_id: String(p.moment_id),
        collection_id: p.collection_id,
        edition_id: p.edition_key,
        player_name: p.player_name,
        set_name: p.set_name,
        serial_number: p.serial_number,
        circulation_count: p.mint_count,
        tier: p.tier,
        thumbnail_url: sanitizeTrophyThumbnail(p.image_url),
        fmv: fmvNum(p.fmv_usd),
        pinned_at: now,
      })),
      { onConflict: "user_id,case_id,slot", ignoreDuplicates: true },
    )
    .select("slot")
  if (error) {
    console.error("[trophy fill] insert failed")
    return apiErrorResponse(error, ROUTE, "Couldn't fill your case right now.")
  }
  const pinnedSlots = (Array.isArray(data) ? data : []) as { slot: number }[]
  // Campaign attribution for the main case, as a hand pin logs it. A failed log
  // does not fail the fill (milestones come from a DB trigger on trophy_moments).
  for (const r of pinnedSlots) {
    await logTrophyFunnelEvent(supabase as any, {
      eventType: "trophy_pinned",
      userId: user.id,
      slot: r.slot,
      userAgent: req.headers?.get?.("user-agent") ?? null,
    })
  }
  warmCardsLater(supabase, user.id, null)
  return NextResponse.json({ need: free.length, picks: proposal, short: free.length - pinnedSlots.length, pinned: pinnedSlots.length })
}
