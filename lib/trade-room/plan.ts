// lib/trade-room/plan.ts
//
// A trade planned on /trades/compare, carried into the room it started (2026-11-16; Trevor: "Yes"
// to pre-filling a planned trade). Table `trade_room_plans` (service role only).
//
// It is a GUIDE, like the Trade Block proposal a room can come from — never a pick. The room shows
// it, and each side adds ITS OWN planned Moments with one tap through the normal `items` action
// (chain-checked held, unlocked, not listed, receivable). Only what both sides pick and accept moves.
//
// The display lines are read from RPC's index on the SERVER when the room is created — the browser
// sends moment ids only, so nothing it says ends up on the other collector's screen.

import type { SupabaseClient } from "@supabase/supabase-js"
import { MOMENT_ID, TradeRoomError } from "@/lib/trade-room/store"
import { MAX_ITEMS_PER_SIDE } from "@/lib/trade-room/valuation"
import { TOP_SHOT_COLLECTION_ID } from "@/lib/trade-room/holdings"
import type { AgreedItem } from "@/lib/trade-room/view"

const USERNAME = /^[A-Za-z0-9_.-]{1,40}$/

export interface PlanInput {
  partner_username: string
  /** Top Shot moment ids the room's creator (side A) plans to give. */
  give: string[]
  /** Top Shot moment ids the partner (side B) plans to give. */
  get: string[]
}

export interface FromCompare {
  partner_username: string
  a_gives: AgreedItem[]
  b_gives: AgreedItem[]
}

/** Validate a plan from a request body. Null when no plan was sent; throws 400 on a bad one. */
export function readPlan(raw: unknown): PlanInput | null {
  if (raw == null) return null
  const p = raw as Record<string, unknown>
  const partner = String(p.partner_username ?? "").trim().replace(/^@/, "")
  if (!USERNAME.test(partner)) throw new TradeRoomError("The planned trade is missing its partner.", 400, "bad_plan")
  const ids = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    const out = [...new Set(v.map((x) => String(x).trim()))]
    for (const id of out) if (!MOMENT_ID.test(id)) throw new TradeRoomError("The planned trade has an unreadable Moment.", 400, "bad_plan")
    return out
  }
  const give = ids(p.give)
  const get = ids(p.get)
  if (give.length > MAX_ITEMS_PER_SIDE || get.length > MAX_ITEMS_PER_SIDE) {
    throw new TradeRoomError(`At most ${MAX_ITEMS_PER_SIDE} Moments per side.`, 400, "too_many")
  }
  if (give.length === 0 && get.length === 0) return null
  return { partner_username: partner, give, get }
}

type Snap = { moment_id: string; player_name: string | null; set_name: string | null; serial_number: number | null }

/** Display lines for Top Shot moment ids, from RPC's index (moment_id is unique within a collection). */
async function snapshot(db: SupabaseClient, ids: readonly string[]): Promise<Map<string, Snap>> {
  const out = new Map<string, Snap>()
  if (ids.length === 0) return out
  const { data, error } = await db
    .from("wallet_moments_cache")
    .select("moment_id, player_name, set_name, serial_number")
    .eq("collection_id", TOP_SHOT_COLLECTION_ID)
    .in("moment_id", [...ids])
    .limit(200)
  if (error) throw new Error(`wallet_moments_cache plan snapshot failed: ${error.message}`)
  for (const r of (data ?? []) as Snap[]) if (!out.has(String(r.moment_id))) out.set(String(r.moment_id), r)
  return out
}

function line(id: string, s: Snap | undefined): AgreedItem {
  return { collection: "Top Shot", moment_id: id, player_name: s?.player_name ?? null, set_name: s?.set_name ?? null, serial_number: s?.serial_number ?? null }
}

/** Store the plan on a room just created by `userId`. Throws on a failed read or write. */
export async function savePlan(db: SupabaseClient, roomId: string, userId: string, plan: PlanInput): Promise<void> {
  const snaps = await snapshot(db, [...plan.give, ...plan.get])
  const { error } = await db.from("trade_room_plans").insert({
    room_id: roomId,
    created_by: userId,
    partner_username: plan.partner_username,
    a_gives: plan.give.map((id) => line(id, snaps.get(id))),
    b_gives: plan.get.map((id) => line(id, snaps.get(id))),
  })
  if (error) throw new Error(`trade_room_plans insert failed: ${error.message}`)
}

/** The plan a room was started with, or null. Throws on a failed read (callers drop the guide). */
export async function planForRoom(db: SupabaseClient, roomId: string): Promise<FromCompare | null> {
  const { data, error } = await db.from("trade_room_plans").select("partner_username, a_gives, b_gives").eq("room_id", roomId).maybeSingle()
  if (error) throw new Error(`trade_room_plans read failed: ${error.message}`)
  if (!data) return null
  const d = data as { partner_username: string; a_gives: unknown; b_gives: unknown }
  const items = (v: unknown): AgreedItem[] =>
    Array.isArray(v)
      ? v
          .map((x) => x as Partial<AgreedItem>)
          .filter((x) => typeof x.moment_id === "string" && MOMENT_ID.test(x.moment_id))
          .map((x) => ({ collection: x.collection ?? "Top Shot", moment_id: x.moment_id as string, player_name: x.player_name ?? null, set_name: x.set_name ?? null, serial_number: x.serial_number ?? null }))
      : []
  return { partner_username: d.partner_username, a_gives: items(d.a_gives), b_gives: items(d.b_gives) }
}
