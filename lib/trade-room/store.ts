// lib/trade-room/store.ts
//
// Trade rooms (migration 20261031174000; multi-collection 20261102205817): the PROPOSAL
// half of a user-to-user trade of NBA Top Shot, NFL All Day, LaLiga Golazos and UFC Strike Moments. Two signed-in RPC users meet in a room, each proves a Flow Wallet,
// picks the moments they give, and accepts the exact version of the proposal they
// are looking at. Any change to either side bumps the version and clears both
// acceptances, so nobody can be held to a proposal that changed under them.
//
// Server-only, service role. Every mutation is scoped to the caller's own side; a
// user can never edit the other side. The chain half (simulate, sign, relay) lives
// in lib/trade-room/execute.ts and reuses the admin swap test's code.

import { randomBytes } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { MAX_ITEMS_PER_SIDE } from "@/lib/trade-room/valuation"
import { RELAY_TTL_MS } from "@/lib/swap-test/relay"

/**
 * A refusal with copy written for the user. `copy` is what a route publishes —
 * it is never a driver/transport message (those are logged, then answered through
 * apiErrorResponse), and the leak guards key on `.message`, so routes read `.copy`.
 */
export class TradeRoomError extends Error {
  readonly copy: string
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = "TradeRoomError"
    this.copy = message
  }
}

/** Wraps a sibling helper's own-copy error (SwapTestError, GiveawayError) as a TradeRoomError. */
export function asTradeRoomError(e: unknown): TradeRoomError | null {
  if (e instanceof TradeRoomError) return e
  if (e instanceof Error && (e.name === "SwapTestError" || e.name === "GiveawayError")) {
    const s = e as Error & { status?: unknown; code?: unknown }
    const status = typeof s.status === "number" ? s.status : 500
    const code = typeof s.code === "string" ? s.code : "internal"
    return new TradeRoomError(e.message, status, code)
  }
  return null
}

export type Side = "a" | "b"
export type RoomStatus = "open" | "building" | "accepted" | "signing" | "sealed" | "cancelled"
/** `expired` is derived from expires_at on read, never stored. */
export type RoomState = RoomStatus | "expired"

export interface RoomRow {
  id: string
  code: string
  created_by: string | null
  collection: string
  status: RoomStatus
  version: number
  tx_id: string | null
  landed: unknown
  sealed_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export interface SideRow {
  room_id: string
  side: Side
  user_id: string
  signer: string | null
  source: string | null
  proven_at: string | null
  accepted_version: number | null
  notice_read_at: string | null
  updated_at: string
}

/** collections.slug of a room item (lib/trade-room/multi-swap-cadence.ts SWAP_COLLECTIONS). */
export type ItemCollection = "nba_top_shot" | "nfl_all_day" | "laliga_golazos" | "ufc_strike"
export const ITEM_COLLECTIONS: ReadonlySet<string> = new Set(["nba_top_shot", "nfl_all_day", "laliga_golazos", "ufc_strike"])

export interface ItemRow {
  room_id: string
  side: Side
  /** Moment ids are unique only WITHIN a collection; every key includes this. */
  collection: ItemCollection
  moment_id: string
  edition_key: string | null
  serial_number: number | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  image_url: string | null
  fmv_usd: number | null
  added_at: string
}

export interface LoadedRoom {
  room: RoomRow
  sides: SideRow[]
  items: ItemRow[]
}

export const ROOM_CODE = /^[a-z0-9]{10}$/
export const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/
export const MOMENT_ID = /^[0-9]{1,20}$/
export { MAX_ITEMS_PER_SIDE }
const ROOM_COLS = "id, code, created_by, collection, status, version, tx_id, landed, sealed_at, cancelled_by, cancel_reason, expires_at, created_at, updated_at"
const SIDE_COLS = "room_id, side, user_id, signer, source, proven_at, accepted_version, notice_read_at, updated_at"
const ITEM_COLS = "room_id, side, collection, moment_id, edition_key, serial_number, player_name, set_name, tier, series_number, image_url, fmv_usd, added_at"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

/** 10 lowercase base-36 characters from the OS RNG (~51 bits): the room's URL. */
export function newRoomCode(bytes: (n: number) => Buffer = randomBytes): string {
  const b = bytes(10)
  let out = ""
  for (let i = 0; i < 10; i++) out += ALPHABET[b[i] % ALPHABET.length]
  return out
}

export function isExpired(room: Pick<RoomRow, "expires_at">, now: number): boolean {
  const t = Date.parse(room.expires_at)
  return !Number.isFinite(t) || t <= now
}

/** The status a reader sees: a finished room keeps its status; a live one may have expired. */
export function roomState(room: Pick<RoomRow, "status" | "expires_at">, now: number): RoomState {
  if (room.status === "sealed" || room.status === "cancelled") return room.status
  return isExpired(room, now) ? "expired" : room.status
}

/** Rooms that can still be edited. */
export const EDITABLE: ReadonlySet<RoomStatus> = new Set(["open", "building", "accepted"])

function fail(error: { message: string } | null, what: string): never {
  throw new Error(`${what}: ${error?.message ?? "no rows returned"}`)
}

export async function createRoom(db: SupabaseClient, userId: string, now: number = Date.now()): Promise<LoadedRoom> {
  // a code collision is ~impossible (51 bits) but the UNIQUE index makes it loud, not silent
  const { data: room, error } = await db
    .from("trade_rooms")
    .insert({ code: newRoomCode(), created_by: userId, expires_at: new Date(now + 7 * 24 * 3600 * 1000).toISOString() })
    .select(ROOM_COLS)
    .single()
  if (error || !room) fail(error, "trade_rooms insert")
  const r = room as RoomRow
  const { error: sideError } = await db.from("trade_room_sides").insert({ room_id: r.id, side: "a", user_id: userId })
  if (sideError) fail(sideError, "trade_room_sides insert")
  return loadRoom(db, r.code)
}

export async function loadRoom(db: SupabaseClient, code: string): Promise<LoadedRoom> {
  if (!ROOM_CODE.test(code)) throw new TradeRoomError("No such trade.", 404, "not_found")
  const { data: room, error } = await db.from("trade_rooms").select(ROOM_COLS).eq("code", code).maybeSingle()
  if (error) fail(error, "trade_rooms read")
  if (!room) throw new TradeRoomError("No such trade.", 404, "not_found")
  const r = room as RoomRow
  const [sides, items] = await Promise.all([
    db.from("trade_room_sides").select(SIDE_COLS).eq("room_id", r.id).order("side"),
    db.from("trade_room_items").select(ITEM_COLS).eq("room_id", r.id).order("added_at"),
  ])
  if (sides.error) fail(sides.error, "trade_room_sides read")
  if (items.error) fail(items.error, "trade_room_items read")
  return {
    room: r,
    sides: (sides.data ?? []) as SideRow[],
    items: ((items.data ?? []) as ItemRow[]).map((i) => ({ ...i, fmv_usd: i.fmv_usd == null ? null : Number(i.fmv_usd) })),
  }
}

/** The caller's side in a room, or null when they are not in it. */
export function sideOf(loaded: LoadedRoom, userId: string): SideRow | null {
  return loaded.sides.find((s) => s.user_id === userId) ?? null
}

export function otherSide(side: Side): Side {
  return side === "a" ? "b" : "a"
}

function requireEditable(loaded: LoadedRoom, now: number): void {
  const state = roomState(loaded.room, now)
  if (state === "expired") throw new TradeRoomError("This trade expired. Start a new one.", 409, "expired")
  if (!EDITABLE.has(loaded.room.status)) {
    throw new TradeRoomError(
      loaded.room.status === "sealed" ? "This trade already sealed on chain." : loaded.room.status === "cancelled" ? "This trade was cancelled." : "This trade is being signed; it can't change now.",
      409,
      loaded.room.status,
    )
  }
}

/**
 * Any change to a side happens in THREE steps (2026-11-07 review):
 *
 *   1. `claimEdit` — bump the version, conditional on the version the caller
 *      loaded AND on the room still being editable, BEFORE any row is written.
 *      A stale edit is refused here and writes nothing. (The old single `touch`
 *      ran AFTER the writes, so a losing edit's rows had already landed under
 *      the winner's version — a counterparty could accept v6 showing X while
 *      the room held Y.)
 *   2. the edit's own writes.
 *   3. `finishEdit` — bump again and clear acceptances again, so an Accept that
 *      read the room MID-write (between 1 and 2) is for a version that no
 *      longer exists.
 *
 * ⛔ Neither step writes `status` from the caller's SNAPSHOT. The old touch did
 * (`status: room.status`), and joins / cancels do not bump the version, so an
 * edit that loaded an "open" room wrote "open" back over B's join (accept's
 * lock then never matched — a stuck room), and an edit that loaded before a
 * cancel wrote the cancelled room back to "building". Only the one transition
 * an edit owns — accepted → building — is written, conditional on itself.
 */
async function claimEdit(db: SupabaseClient, loaded: LoadedRoom): Promise<number> {
  const { room } = loaded
  const claimed = room.version + 1
  const { data, error } = await db
    .from("trade_rooms")
    .update({ version: claimed, updated_at: new Date().toISOString() })
    .eq("id", room.id)
    .eq("version", room.version)
    .in("status", [...EDITABLE])
    .select("id")
  if (error) fail(error, "trade_rooms claim edit")
  if (!Array.isArray(data) || data.length !== 1) throw new TradeRoomError("The trade changed while you were editing it. Reload and try again.", 409, "stale")
  await resetAcceptances(db, room.id)
  return claimed
}

async function finishEdit(db: SupabaseClient, roomId: string, claimed: number): Promise<void> {
  // 0 rows = another edit bumped it already (and reset acceptances itself) — fine.
  const { error } = await db
    .from("trade_rooms")
    .update({ version: claimed + 1, updated_at: new Date().toISOString() })
    .eq("id", roomId)
    .eq("version", claimed)
  if (error) fail(error, "trade_rooms finish edit")
  await resetAcceptances(db, roomId)
}

async function resetAcceptances(db: SupabaseClient, roomId: string): Promise<void> {
  const { error: sideError } = await db.from("trade_room_sides").update({ accepted_version: null }).eq("room_id", roomId)
  if (sideError) fail(sideError, "trade_room_sides reset acceptances")
  const { error: unlockError } = await db
    .from("trade_rooms")
    .update({ status: "building", updated_at: new Date().toISOString() })
    .eq("id", roomId)
    .eq("status", "accepted")
  if (unlockError) fail(unlockError, "trade_rooms unlock on edit")
}

export async function joinRoom(db: SupabaseClient, loaded: LoadedRoom, userId: string, now: number = Date.now()): Promise<LoadedRoom> {
  if (sideOf(loaded, userId)) return loaded
  requireEditable(loaded, now)
  if (loaded.sides.some((s) => s.side === "b")) throw new TradeRoomError("This trade already has two sides.", 409, "full")
  if (loaded.room.status !== "open") throw new TradeRoomError("This trade is no longer open to join.", 409, "not_open")
  const { error } = await db.from("trade_room_sides").insert({ room_id: loaded.room.id, side: "b", user_id: userId })
  if (error) {
    // UNIQUE (room_id, side): someone else joined first
    if (error.code === "23505") throw new TradeRoomError("Someone else just joined this trade.", 409, "full")
    fail(error, "trade_room_sides insert")
  }
  const { error: statusError } = await db
    .from("trade_rooms")
    .update({ status: "building", updated_at: new Date().toISOString() })
    .eq("id", loaded.room.id)
    .eq("status", "open")
  if (statusError) fail(statusError, "trade_rooms join")
  return loadRoom(db, loaded.room.code)
}

/**
 * Records the wallet this side PROVED (signer) and the account its moments sit in
 * (source). A changed source empties the side's picks: they were read from the old
 * account. Both reset acceptances.
 */
export async function setWallet(
  db: SupabaseClient,
  loaded: LoadedRoom,
  side: SideRow,
  signer: string,
  source: string,
  now: number = Date.now(),
): Promise<LoadedRoom> {
  requireEditable(loaded, now)
  if (!FLOW_ADDRESS.test(signer) || !FLOW_ADDRESS.test(source)) throw new TradeRoomError("Not a Flow address.", 400, "bad_address")
  const other = loaded.sides.find((s) => s.side !== side.side)
  if (other?.signer === signer) throw new TradeRoomError("The two sides need two different wallets.", 409, "same_signer")
  if (other?.source === source) throw new TradeRoomError("Both sides can't draw from the same account.", 409, "same_source")
  const sourceChanged = side.source !== null && side.source !== source
  const claimed = await claimEdit(db, loaded)
  const { error } = await db
    .from("trade_room_sides")
    .update({ signer, source, proven_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() })
    .eq("room_id", loaded.room.id)
    .eq("side", side.side)
  if (error) fail(error, "trade_room_sides wallet")
  if (sourceChanged) {
    const { error: itemError } = await db.from("trade_room_items").delete().eq("room_id", loaded.room.id).eq("side", side.side)
    if (itemError) fail(itemError, "trade_room_items clear")
  }
  await finishEdit(db, loaded.room.id, claimed)
  return loadRoom(db, loaded.room.code)
}

export type NewItem = Omit<ItemRow, "room_id" | "side" | "added_at">

const itemKey = (i: { collection: string; moment_id: string }) => `${i.collection}:${i.moment_id}`

/** trade_rooms.collection for a set of items: the one collection they share, or "mixed". */
export function roomCollection(items: ReadonlyArray<{ collection: string }>): string {
  const set = new Set(items.map((i) => i.collection))
  if (set.size === 0) return "nba_top_shot"
  return set.size === 1 ? [...set][0] : "mixed"
}

/** Replaces this side's picks wholesale (the chain check happens before this is called). */
export async function setItems(db: SupabaseClient, loaded: LoadedRoom, side: SideRow, items: NewItem[], now: number = Date.now()): Promise<LoadedRoom> {
  requireEditable(loaded, now)
  if (!side.signer || !side.source) throw new TradeRoomError("Connect and prove your Flow Wallet before picking Moments.", 409, "no_wallet")
  if (items.length > MAX_ITEMS_PER_SIDE) throw new TradeRoomError(`At most ${MAX_ITEMS_PER_SIDE} Moments per side.`, 400, "too_many")
  if (items.some((i) => !ITEM_COLLECTIONS.has(i.collection))) throw new TradeRoomError("That collection can't be traded here.", 400, "bad_collection")
  if (items.some((i) => !MOMENT_ID.test(i.moment_id))) throw new TradeRoomError("A moment id is not a number.", 400, "bad_id")
  const keys = items.map(itemKey)
  if (new Set(keys).size !== keys.length) throw new TradeRoomError("A Moment is listed twice.", 400, "duplicate_id")
  const theirs = new Set(loaded.items.filter((i) => i.side !== side.side).map(itemKey))
  if (keys.some((k) => theirs.has(k))) throw new TradeRoomError("That Moment is already on the other side.", 409, "on_other_side")
  const claimed = await claimEdit(db, loaded)
  // order matters: write the new set first, then remove what is not in it, so a failure
  // between the two never leaves the side empty by accident
  if (items.length) {
    const { error } = await db
      .from("trade_room_items")
      .upsert(items.map((i) => ({ ...i, room_id: loaded.room.id, side: side.side })), { onConflict: "room_id,side,collection,moment_id" })
    if (error) fail(error, "trade_room_items upsert")
  }
  // prune per collection (a moment id means nothing without its collection)
  for (const c of ITEM_COLLECTIONS) {
    const keep = items.filter((i) => i.collection === c).map((i) => i.moment_id)
    let del = db.from("trade_room_items").delete().eq("room_id", loaded.room.id).eq("side", side.side).eq("collection", c)
    if (keep.length) del = del.not("moment_id", "in", `(${keep.map((id) => `"${id}"`).join(",")})`)
    const { error: delError } = await del
    if (delError) fail(delError, "trade_room_items prune")
  }
  await finishEdit(db, loaded.room.id, claimed)
  const next = await loadRoom(db, loaded.room.code)
  // keep trade_rooms.collection in step with what the room now holds
  const collection = roomCollection(next.items)
  if (collection !== next.room.collection) {
    const { error: colError } = await db.from("trade_rooms").update({ collection }).eq("id", next.room.id)
    if (colError) fail(colError, "trade_rooms collection")
    next.room = { ...next.room, collection }
  }
  return next
}

/**
 * Accept the proposal AS LOADED (the version the user saw). Both sides must have a
 * proven wallet and at least one Moment must change hands; the withdrawal notice
 * must have been read. When the other side has accepted the same version, the room
 * becomes "accepted" and may be executed.
 */
export async function accept(db: SupabaseClient, loaded: LoadedRoom, side: SideRow, version: number, noticeRead: boolean, now: number = Date.now()): Promise<LoadedRoom> {
  requireEditable(loaded, now)
  if (version !== loaded.room.version) throw new TradeRoomError("The trade changed since you looked at it. Review it again.", 409, "stale")
  if (!noticeRead) throw new TradeRoomError("Read the notice about what leaves a Dapper account before accepting.", 400, "notice")
  const sides = loaded.sides
  if (sides.length !== 2) throw new TradeRoomError("Waiting for the other side to join.", 409, "no_counterparty")
  if (sides.some((s) => !s.signer || !s.source)) throw new TradeRoomError("Both sides need a proven Flow Wallet before accepting.", 409, "no_wallet")
  if (loaded.items.length === 0) throw new TradeRoomError("Neither side gives anything.", 409, "empty")
  const stamp = new Date(now).toISOString()
  const { error } = await db
    .from("trade_room_sides")
    .update({ accepted_version: version, notice_read_at: side.notice_read_at ?? stamp, updated_at: stamp })
    .eq("room_id", loaded.room.id)
    .eq("side", side.side)
  if (error) fail(error, "trade_room_sides accept")
  // ⚠ Decide the lock from the sides AS THEY ARE NOW, not the pre-write snapshot
  // (2026-11-07 review): two Accepts in the same second each saw the other as
  // null, neither locked, and the room sat "building" with both sides accepted.
  // After its own write, each request re-reads; the later one sees both.
  const { data: nowSides, error: readError } = await db
    .from("trade_room_sides")
    .select("side, accepted_version")
    .eq("room_id", loaded.room.id)
  if (readError) fail(readError, "trade_room_sides accept re-read")
  const rows = (nowSides ?? []) as Array<{ side: Side; accepted_version: number | null }>
  if (rows.length === 2 && rows.every((r) => r.accepted_version === version)) {
    // both accepted this exact version: lock the room. Conditional on the version so a
    // concurrent edit (which resets acceptances) cannot be overtaken.
    const { error: lockError } = await db
      .from("trade_rooms")
      .update({ status: "accepted", updated_at: stamp })
      .eq("id", loaded.room.id)
      .eq("version", version)
      .in("status", ["building"])
    if (lockError) fail(lockError, "trade_rooms lock")
  }
  return loadRoom(db, loaded.room.code)
}

export async function unaccept(db: SupabaseClient, loaded: LoadedRoom, side: SideRow, now: number = Date.now()): Promise<LoadedRoom> {
  requireEditable(loaded, now)
  const { error } = await db
    .from("trade_room_sides")
    .update({ accepted_version: null, updated_at: new Date(now).toISOString() })
    .eq("room_id", loaded.room.id)
    .eq("side", side.side)
  if (error) fail(error, "trade_room_sides unaccept")
  if (loaded.room.status === "accepted") {
    const { error: e2 } = await db.from("trade_rooms").update({ status: "building", updated_at: new Date(now).toISOString() }).eq("id", loaded.room.id).eq("status", "accepted")
    if (e2) fail(e2, "trade_rooms unlock")
  }
  return loadRoom(db, loaded.room.code)
}

export async function cancelRoom(db: SupabaseClient, loaded: LoadedRoom, userId: string, reason: string | null, now: number = Date.now()): Promise<LoadedRoom> {
  if (loaded.room.status === "sealed") throw new TradeRoomError("This trade already sealed on chain; it can't be cancelled.", 409, "sealed")
  if (loaded.room.status === "cancelled") return loaded
  // ⛔ 2026-11-07 review: once the co-signer has SIGNED, the transaction can seal
  // on chain at any moment — a cancel then recorded a trade that executed as
  // "cancelled" and emailed "Nothing moved". Refuse while a signature from the
  // relay window exists; after the window (or when signing ended) cancel works.
  // A failed read refuses too: we cannot say nothing was signed.
  if (loaded.room.status === "signing") {
    const { count, error: relayError } = await db
      .from("trade_room_relay")
      .select("id", { count: "exact", head: true })
      .eq("room_id", loaded.room.id)
      .not("signed_at", "is", null)
      .gt("created_at", new Date(now - RELAY_TTL_MS).toISOString())
    if (relayError || count == null) throw new TradeRoomError("Couldn't check whether the trade was already signed. Try again in a moment.", 503, "unavailable")
    if (count > 0) throw new TradeRoomError("The other wallet already signed — this trade may be sealing on chain now, so it can't be cancelled. Check it in a moment.", 409, "cosigned")
  }
  const r = reason ? reason.replace(/\s+/g, " ").trim().slice(0, 200) : null
  const { error } = await db
    .from("trade_rooms")
    .update({ status: "cancelled", cancelled_by: userId, cancel_reason: r, updated_at: new Date(now).toISOString() })
    .eq("id", loaded.room.id)
    .neq("status", "sealed")
  if (error) fail(error, "trade_rooms cancel")
  return loadRoom(db, loaded.room.code)
}

/** A wallet has been asked to sign: freeze the proposal. */
export async function markSigning(db: SupabaseClient, loaded: LoadedRoom, now: number = Date.now()): Promise<void> {
  const { data, error } = await db
    .from("trade_rooms")
    .update({ status: "signing", updated_at: new Date(now).toISOString() })
    .eq("id", loaded.room.id)
    .eq("version", loaded.room.version)
    .in("status", ["accepted", "signing"])
    .select("id")
  if (error) fail(error, "trade_rooms signing")
  if (!Array.isArray(data) || data.length !== 1) throw new TradeRoomError("The trade changed before signing started. Review it again.", 409, "stale")
}

/** A signing attempt ended without a seal (wallet refused, relay expired): back to accepted. */
export async function markSigningEnded(db: SupabaseClient, loaded: LoadedRoom, now: number = Date.now()): Promise<void> {
  const { error } = await db
    .from("trade_rooms")
    .update({ status: "accepted", updated_at: new Date(now).toISOString() })
    .eq("id", loaded.room.id)
    .eq("status", "signing")
  if (error) fail(error, "trade_rooms signing ended")
}

export async function markSealed(db: SupabaseClient, loaded: LoadedRoom, txId: string, landed: unknown, now: number = Date.now()): Promise<LoadedRoom> {
  if (!/^[0-9a-f]{64}$/.test(txId)) throw new TradeRoomError("Not a Flow transaction id.", 400, "bad_tx")
  const stamp = new Date(now).toISOString()
  const { error } = await db
    .from("trade_rooms")
    .update({ status: "sealed", tx_id: txId, landed: landed ?? null, sealed_at: stamp, updated_at: stamp })
    .eq("id", loaded.room.id)
    // "cancelled" too: the caller records a seal only after the CHAIN shows every
    // Moment landed, and the chain outranks a cancel row (2026-11-07 review).
    .in("status", ["accepted", "signing", "sealed", "cancelled"])
  if (error) fail(error, "trade_rooms sealed")
  return loadRoom(db, loaded.room.code)
}

export interface RoomListEntry {
  code: string
  status: RoomState
  version: number
  side: Side
  counterparty_present: boolean
  gives: number
  gets: number
  tx_id: string | null
  updated_at: string
  expires_at: string
}

/** The caller's rooms, newest first. */
export async function listRooms(db: SupabaseClient, userId: string, now: number = Date.now()): Promise<RoomListEntry[]> {
  const { data: mine, error } = await db.from("trade_room_sides").select("room_id, side").eq("user_id", userId)
  if (error) fail(error, "trade_room_sides list")
  const ids = (mine ?? []).map((m) => (m as { room_id: string }).room_id)
  if (ids.length === 0) return []
  // CHUNKED (2026-11-07 review): one unpaged `.in()` over every historical room
  // clamped the item read at 1,000 rows (gives/gets counts silently wrong, 0
  // included) and, with a few hundred rooms, overflowed the request URL — which
  // also broke room CREATION, since the live-room cap calls this first. 40 rooms
  // × ≤ 2 × MAX_ITEMS_PER_SIDE items stays under the clamp.
  const CHUNK = 40
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
  const reads = await Promise.all(
    chunks.map((c) =>
      Promise.all([
        db.from("trade_rooms").select(ROOM_COLS).in("id", c),
        db.from("trade_room_sides").select("room_id, side").in("room_id", c),
        db.from("trade_room_items").select("room_id, side").in("room_id", c),
      ]),
    ),
  )
  const roomRows: RoomRow[] = []
  const sideRows: Array<{ room_id: string }> = []
  const itemRows: Array<{ room_id: string; side: Side }> = []
  for (const [r, sd, it] of reads) {
    if (r.error) fail(r.error, "trade_rooms list")
    if (sd.error) fail(sd.error, "trade_room_sides list all")
    if (it.error) fail(it.error, "trade_room_items list")
    roomRows.push(...((r.data ?? []) as RoomRow[]))
    sideRows.push(...((sd.data ?? []) as Array<{ room_id: string }>))
    itemRows.push(...((it.data ?? []) as Array<{ room_id: string; side: Side }>))
  }
  roomRows.sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)))
  const rooms = { data: roomRows }
  const sides = { data: sideRows }
  const items = { data: itemRows }
  const mySide = new Map((mine ?? []).map((m) => [(m as { room_id: string }).room_id, (m as { side: Side }).side]))
  const sideCount = new Map<string, number>()
  for (const s of (sides.data ?? []) as Array<{ room_id: string }>) sideCount.set(s.room_id, (sideCount.get(s.room_id) ?? 0) + 1)
  const given = new Map<string, number>()
  for (const i of (items.data ?? []) as Array<{ room_id: string; side: Side }>) given.set(`${i.room_id}:${i.side}`, (given.get(`${i.room_id}:${i.side}`) ?? 0) + 1)
  return ((rooms.data ?? []) as RoomRow[]).map((r) => {
    const side = mySide.get(r.id) as Side
    return {
      code: r.code,
      status: roomState(r, now),
      version: r.version,
      side,
      counterparty_present: (sideCount.get(r.id) ?? 0) === 2,
      gives: given.get(`${r.id}:${side}`) ?? 0,
      gets: given.get(`${r.id}:${otherSide(side)}`) ?? 0,
      tx_id: r.tx_id,
      updated_at: r.updated_at,
      expires_at: r.expires_at,
    }
  })
}
