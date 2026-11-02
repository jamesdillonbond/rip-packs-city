// lib/trade-room/view.ts
//
// What a signed-in viewer sees of a trade room. Server-side shaping only: usernames
// instead of user ids (RPC refers to users by username, never id), each side's
// picks with RPC's FMV where it was confident (and `priced: false` otherwise — the
// confidence tier never leaves the server), the fair-trade hint, and whether the
// on-chain step is open. Everything here is derived from the loaded rows; nothing
// is read from the chain.

import type { SupabaseClient } from "@supabase/supabase-js"
import { EXECUTE_CLOSED_MESSAGE, executionOpen } from "@/lib/trade-room/execute"
import { otherSide, roomState, type ItemRow, type LoadedRoom, type RoomState, type Side, type SideRow } from "@/lib/trade-room/store"
import { valueTrade, WITHDRAWAL_NOTICE, type TradeValuation } from "@/lib/trade-room/valuation"

export interface ItemView {
  /** collections.slug (nba_top_shot / nfl_all_day / laliga_golazos / ufc_strike). */
  collection: string
  moment_id: string
  edition_key: string | null
  serial_number: number | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  image_url: string | null
  /** RPC FMV at add time when confident; null = not priced. */
  fmv_usd: number | null
  priced: boolean
}

export interface SideView {
  side: Side
  username: string
  is_me: boolean
  signer: string | null
  source: string | null
  proven: boolean
  /** Accepted the room's CURRENT version. */
  accepted: boolean
  items: ItemView[]
}

export interface PendingRelay {
  id: string
  cosigner: string
  signable: Record<string, unknown>
  created_at: string
}

export interface RoomView {
  code: string
  state: RoomState
  version: number
  collection: string
  created_at: string
  updated_at: string
  expires_at: string
  tx_id: string | null
  sealed_at: string | null
  landed: unknown
  cancel_reason: string | null
  cancelled_by_me: boolean
  /** The viewer's side, or null when they are not in this room. */
  me: { side: Side; notice_read: boolean } | null
  can_join: boolean
  a: SideView
  /** Null until the counterparty joins. */
  b: SideView | null
  valuation: TradeValuation
  notice: string
  execution: { open: boolean; message: string | null }
  /** A relay waiting for THIS viewer's wallet to co-sign, when one is pending. */
  relay: PendingRelay | null
  /** The Trade Block proposal this room was opened from (2026-11-02), when there is one:
   *  what each side agreed to give there, as a guide for the picks. Never a pick itself —
   *  the room's own picks and chain checks decide what moves. */
  from_block: FromBlock | null
}

export interface AgreedItem {
  moment_id: string
  player_name: string | null
  set_name: string | null
  serial_number: number | null
}

export interface FromBlock {
  listing_code: string | null
  a_gives: AgreedItem[]
  b_gives: AgreedItem[]
}

export function itemView(i: ItemRow): ItemView {
  const priced = typeof i.fmv_usd === "number" && Number.isFinite(i.fmv_usd)
  return {
    collection: i.collection ?? "nba_top_shot",
    moment_id: i.moment_id,
    edition_key: i.edition_key,
    serial_number: i.serial_number,
    player_name: i.player_name,
    set_name: i.set_name,
    tier: i.tier,
    series_number: i.series_number,
    image_url: i.image_url,
    fmv_usd: priced ? i.fmv_usd : null,
    priced,
  }
}

export const ANONYMOUS_USERNAME = "A collector"

/** profile_bio.username per user id; a user with no row reads as "A collector". */
export async function usernamesFor(db: SupabaseClient, userIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (userIds.length === 0) return out
  const { data, error } = await db.from("profile_bio").select("user_id, username").in("user_id", [...new Set(userIds)])
  if (error) throw new Error(`profile_bio read failed: ${error.message}`)
  for (const r of (data ?? []) as Array<{ user_id: string; username: string | null }>) {
    const u = (r.username ?? "").trim()
    if (u) out.set(r.user_id, u)
  }
  return out
}

function sideView(loaded: LoadedRoom, s: SideRow, viewerId: string, names: Map<string, string>): SideView {
  return {
    side: s.side,
    username: names.get(s.user_id) ?? ANONYMOUS_USERNAME,
    is_me: s.user_id === viewerId,
    signer: s.signer,
    source: s.source,
    proven: Boolean(s.signer && s.source),
    accepted: s.accepted_version === loaded.room.version,
    items: loaded.items.filter((i) => i.side === s.side).map(itemView),
  }
}

export interface BuildViewOpts {
  now?: number
  relay?: PendingRelay | null
  fromBlock?: FromBlock | null
  env?: Record<string, string | undefined>
}

/** A room with a missing side A reads as a room whose creator left (account deleted). */
export function buildRoomView(loaded: LoadedRoom, viewerId: string, names: Map<string, string>, opts: BuildViewOpts = {}): RoomView {
  const now = opts.now ?? Date.now()
  const { room } = loaded
  const mine = loaded.sides.find((s) => s.user_id === viewerId) ?? null
  const a = loaded.sides.find((s) => s.side === "a") ?? null
  const b = loaded.sides.find((s) => s.side === "b") ?? null
  const state = roomState(room, now)
  const valuation = valueTrade(
    loaded.items.filter((i) => i.side === "a"),
    loaded.items.filter((i) => i.side === "b"),
  )
  const open = executionOpen(opts.env)
  const aView: SideView = a
    ? sideView(loaded, a, viewerId, names)
    : { side: "a", username: "A collector who left", is_me: false, signer: null, source: null, proven: false, accepted: false, items: loaded.items.filter((i) => i.side === "a").map(itemView) }
  return {
    code: room.code,
    state,
    version: room.version,
    collection: room.collection,
    created_at: room.created_at,
    updated_at: room.updated_at,
    expires_at: room.expires_at,
    tx_id: room.tx_id,
    sealed_at: room.sealed_at,
    landed: room.landed ?? null,
    cancel_reason: room.cancel_reason,
    cancelled_by_me: room.cancelled_by === viewerId,
    me: mine ? { side: mine.side, notice_read: mine.notice_read_at != null } : null,
    can_join: !mine && state === "open" && b === null,
    a: aView,
    b: b ? sideView(loaded, b, viewerId, names) : null,
    valuation,
    notice: WITHDRAWAL_NOTICE,
    execution: { open, message: open ? null : EXECUTE_CLOSED_MESSAGE },
    relay: opts.relay ?? null,
    from_block: opts.fromBlock ?? null,
  }
}

/** The side that would co-sign a relay the viewer initiates. */
export function cosignerOf(loaded: LoadedRoom, mySide: Side): SideRow | null {
  return loaded.sides.find((s) => s.side === otherSide(mySide)) ?? null
}
