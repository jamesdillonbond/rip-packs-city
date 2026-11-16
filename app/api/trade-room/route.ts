// app/api/trade-room/route.ts
//
// Trade rooms, the collection: user-to-user trades — Top Shot, and since 2026-11-02 All Day / Golazos / UFC (Trevor, 2026-10-31;
// docs/strategy/trading-revisit-2026-10-03.md shape A). Signed in only — proxy.ts
// sends anon callers to /login and requireUser answers 401 regardless.
//
//   GET          -> { rooms: RoomListEntry[] }   the caller's rooms, newest first
//   POST {}      -> { room: RoomView }           a new room with the caller as side A
//   POST { plan: { partner_username, give, get } }
//                -> { room, plan_saved }          the same, carrying a trade planned on /trades/compare
//                                                 (a guide, never a pick — lib/trade-room/plan.ts)
//
// Per-room reads and every mutation live in ./[code]/route.ts.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { createRoom, listRooms, TradeRoomError } from "@/lib/trade-room/store"
import { buildRoomView, usernamesFor } from "@/lib/trade-room/view"
import { planForRoom, readPlan, savePlan } from "@/lib/trade-room/plan"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

/** A user may hold this many unfinished rooms; an abandoned room expires in 7 days. */
export const MAX_LIVE_ROOMS = 20

async function user(req: NextRequest) {
  void req
  try {
    return await requireUser()
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
}

export async function GET(req: NextRequest) {
  const u = await user(req)
  if (u instanceof Response) return u
  try {
    return NextResponse.json({ rooms: await listRooms(supabaseAdmin, u.id) }, { headers: NO_STORE })
  } catch (e) {
    return apiErrorResponse(e, "api/trade-room GET", "We couldn't load your trades. Try again in a moment.")
  }
}

export async function POST(req: NextRequest) {
  const u = await user(req)
  if (u instanceof Response) return u
  let body: Record<string, unknown> = {}
  try {
    const text = await req.text()
    body = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return NextResponse.json({ error: "Body must be JSON.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  try {
    // validated BEFORE the room exists: a bad plan creates nothing
    const plan = readPlan(body?.plan)
    const live = (await listRooms(supabaseAdmin, u.id)).filter((r) => r.status === "open" || r.status === "building" || r.status === "accepted" || r.status === "signing")
    if (live.length >= MAX_LIVE_ROOMS) {
      return NextResponse.json({ error: `You have ${live.length} trades in progress. Cancel or finish one first.`, code: "too_many_rooms" }, { status: 429, headers: NO_STORE })
    }
    const loaded = await createRoom(supabaseAdmin, u.id)
    const names = await usernamesFor(supabaseAdmin, loaded.sides.map((s) => s.user_id))
    if (!plan) return NextResponse.json({ room: buildRoomView(loaded, u.id, names) }, { status: 201, headers: NO_STORE })
    // The room exists either way; a plan that fails to attach is SAID (plan_saved:false), never
    // dropped silently — the page keeps the plan in its own link.
    let fromCompare = null
    let planSaved = false
    try {
      await savePlan(supabaseAdmin, loaded.room.id, u.id, plan)
      fromCompare = await planForRoom(supabaseAdmin, loaded.room.id)
      planSaved = fromCompare !== null
    } catch (e) {
      console.error(`[trade-room] plan save failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return NextResponse.json({ room: buildRoomView(loaded, u.id, names, { fromCompare }), plan_saved: planSaved }, { status: 201, headers: NO_STORE })
  } catch (e) {
    if (e instanceof TradeRoomError) return NextResponse.json({ error: e.copy, code: e.code }, { status: e.status, headers: NO_STORE })
    return apiErrorResponse(e, "api/trade-room POST", "We couldn't start a trade. Try again in a moment.")
  }
}
