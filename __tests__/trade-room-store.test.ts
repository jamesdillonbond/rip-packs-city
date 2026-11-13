import { describe, it, expect } from "vitest"
import { memorySupabase } from "./helpers/memory-supabase"
import {
  accept,
  cancelRoom,
  createRoom,
  isExpired,
  joinRoom,
  listRooms,
  loadRoom,
  markSealed,
  markSigning,
  markSigningEnded,
  newRoomCode,
  roomState,
  setItems,
  setWallet,
  sideOf,
  TradeRoomError,
  unaccept,
  type NewItem,
} from "@/lib/trade-room/store"
import { valueTrade, MAX_ITEMS_PER_SIDE } from "@/lib/trade-room/valuation"
import { buildRoomView, usernamesFor } from "@/lib/trade-room/view"

// The property under test is the PROPOSAL contract: nobody can be held to a
// proposal that changed under them, nobody edits the other side, and a room that
// is being signed or is finished cannot change.

const UNIQUES = {
  trade_rooms: [["code"]],
  trade_room_sides: [["room_id", "side"], ["room_id", "user_id"]],
  trade_room_items: [["room_id", "moment_id"]],
}
// the migration's column DEFAULTs the store relies on
const DEFAULTS = {
  trade_rooms: { status: "open", version: 1, collection: "nba_top_shot", tx_id: null, landed: null, sealed_at: null, cancelled_by: null, cancel_reason: null },
  trade_room_sides: { signer: null, source: null, proven_at: null, accepted_version: null, notice_read_at: null },
}
const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"
const WA = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac" }
const WB = { signer: "0x00000000000000bb", source: "0x00000000000000bc" }

const item = (id: string, fmv: number | null = null): NewItem => ({
  collection: "nba_top_shot",
  moment_id: id,
  edition_key: "1:2",
  serial_number: Number(id),
  player_name: "Player",
  set_name: "Set",
  tier: "COMMON",
  series_number: 8,
  image_url: null,
  fmv_usd: fmv,
})

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof TradeRoomError ? `${e.status}:${e.code}` : `other:${String(e)}`
  }
  return "resolved"
}

async function twoSided() {
  const m = memorySupabase({}, UNIQUES, DEFAULTS)
  let room = await createRoom(m.db, ALICE)
  room = await joinRoom(m.db, room, BOB)
  room = await setWallet(m.db, room, sideOf(room, ALICE)!, WA.signer, WA.source)
  room = await setWallet(m.db, room, sideOf(room, BOB)!, WB.signer, WB.source)
  return { m, room }
}

describe("trade-room/store — codes and state", () => {
  it("makes a 10-char base-36 code from the RNG bytes", () => {
    expect(newRoomCode(() => Buffer.alloc(10, 0))).toBe("aaaaaaaaaa")
    expect(newRoomCode()).toMatch(/^[a-z0-9]{10}$/)
  })

  it("reads 'expired' from expires_at only on a live room; a finished room keeps its status", () => {
    const past = { expires_at: "2020-01-01T00:00:00Z" }
    const now = Date.parse("2026-10-31T17:00:00Z")
    expect(isExpired(past, now)).toBe(true)
    expect(roomState({ status: "building", ...past }, now)).toBe("expired")
    expect(roomState({ status: "sealed", ...past }, now)).toBe("sealed")
    expect(roomState({ status: "cancelled", ...past }, now)).toBe("cancelled")
    // an unparseable expiry is expired, never "open forever"
    expect(roomState({ status: "open", expires_at: "garbage" }, now)).toBe("expired")
  })
})

describe("trade-room/store — the proposal contract", () => {
  it("create → join → wallets: side A is the creator, side B the joiner, status open → building", async () => {
    const m = memorySupabase({}, UNIQUES, DEFAULTS)
    let room = await createRoom(m.db, ALICE)
    expect(room.room.status).toBe("open")
    expect(sideOf(room, ALICE)?.side).toBe("a")
    room = await joinRoom(m.db, room, BOB)
    expect(room.room.status).toBe("building")
    expect(sideOf(room, BOB)?.side).toBe("b")
    // joining twice is a no-op; a third user is refused
    expect((await joinRoom(m.db, room, BOB)).sides).toHaveLength(2)
    expect(await codeOf(joinRoom(m.db, room, "cccccccc-0000-4000-8000-000000000003"))).toBe("409:full")
  })

  it("the two sides need two wallets and two accounts", async () => {
    const m = memorySupabase({}, UNIQUES, DEFAULTS)
    let room = await createRoom(m.db, ALICE)
    room = await joinRoom(m.db, room, BOB)
    room = await setWallet(m.db, room, sideOf(room, ALICE)!, WA.signer, WA.source)
    expect(await codeOf(setWallet(m.db, room, sideOf(room, BOB)!, WA.signer, WB.source))).toBe("409:same_signer")
    expect(await codeOf(setWallet(m.db, room, sideOf(room, BOB)!, WB.signer, WA.source))).toBe("409:same_source")
  })

  it("picks need a proven wallet, are capped, and cannot name a moment on the other side", async () => {
    const m = memorySupabase({}, UNIQUES, DEFAULTS)
    let room = await createRoom(m.db, ALICE)
    room = await joinRoom(m.db, room, BOB)
    expect(await codeOf(setItems(m.db, room, sideOf(room, ALICE)!, [item("1")]))).toBe("409:no_wallet")
    room = await setWallet(m.db, room, sideOf(room, ALICE)!, WA.signer, WA.source)
    room = await setWallet(m.db, room, sideOf(room, BOB)!, WB.signer, WB.source)
    const many = Array.from({ length: MAX_ITEMS_PER_SIDE + 1 }, (_, i) => item(String(i + 1)))
    expect(await codeOf(setItems(m.db, room, sideOf(room, ALICE)!, many))).toBe("400:too_many")
    room = await setItems(m.db, room, sideOf(room, ALICE)!, [item("1"), item("2")])
    expect(await codeOf(setItems(m.db, room, sideOf(room, BOB)!, [item("2")]))).toBe("409:on_other_side")
  })

  it("replacing picks writes the new set BEFORE pruning the old (a failure never empties the side by accident)", async () => {
    const { m, room } = await twoSided()
    const a = sideOf(room, ALICE)!
    const r2 = await setItems(m.db, room, a, [item("1"), item("2")])
    m.log.length = 0
    const r3 = await setItems(m.db, r2, sideOf(r2, ALICE)!, [item("2"), item("3")])
    expect(r3.items.map((i) => i.moment_id).sort()).toEqual(["2", "3"])
    const upsertAt = m.log.indexOf("upsert trade_room_items")
    const deleteAt = m.log.indexOf("delete trade_room_items")
    expect(upsertAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThan(upsertAt)
  })

  it("accept pins the version seen; any change resets BOTH acceptances and drops 'accepted' to 'building'", async () => {
    const two = await twoSided()
    const { m } = two
    let room = two.room
    room = await setItems(m.db, room, sideOf(room, ALICE)!, [item("1", 10)])
    const v = room.room.version
    // a stale version is refused; so is accepting without reading the notice
    expect(await codeOf(accept(m.db, room, sideOf(room, ALICE)!, v - 1, true))).toBe("409:stale")
    expect(await codeOf(accept(m.db, room, sideOf(room, ALICE)!, v, false))).toBe("400:notice")
    room = await accept(m.db, room, sideOf(room, ALICE)!, v, true)
    expect(room.room.status).toBe("building")
    expect(sideOf(room, ALICE)!.accepted_version).toBe(v)
    room = await accept(m.db, room, sideOf(room, BOB)!, v, true)
    expect(room.room.status).toBe("accepted")
    // Bob changes his side: version bumps, both acceptances clear, back to building
    room = await setItems(m.db, room, sideOf(room, BOB)!, [item("9", 5)])
    // RE-PINNED 2026-11-07: an edit claims a version BEFORE writing and bumps again
    // after (so a mid-write Accept is void) — the property is "moved past v".
    expect(room.room.version).toBeGreaterThan(v)
    expect(room.room.status).toBe("building")
    expect(room.sides.every((s) => s.accepted_version === null)).toBe(true)
    // Alice's old acceptance (version v) can no longer lock the room
    expect(await codeOf(accept(m.db, room, sideOf(room, ALICE)!, v, true))).toBe("409:stale")
  })

  it("a concurrent edit is detected: the version bump is conditional on the version loaded", async () => {
    const two = await twoSided()
    const { m } = two
    let room = two.room
    const stale = room
    room = await setItems(m.db, room, sideOf(room, ALICE)!, [item("1")])
    // someone else edits from the stale snapshot
    expect(await codeOf(setItems(m.db, stale, sideOf(stale, BOB)!, [item("2")]))).toBe("409:stale")
  })

  it("accept needs a counterparty, two proven wallets and at least one moment", async () => {
    const m = memorySupabase({}, UNIQUES, DEFAULTS)
    let room = await createRoom(m.db, ALICE)
    expect(await codeOf(accept(m.db, room, sideOf(room, ALICE)!, 1, true))).toBe("409:no_counterparty")
    room = await joinRoom(m.db, room, BOB)
    expect(await codeOf(accept(m.db, room, sideOf(room, ALICE)!, 1, true))).toBe("409:no_wallet")
    room = await setWallet(m.db, room, sideOf(room, ALICE)!, WA.signer, WA.source)
    room = await setWallet(m.db, room, sideOf(room, BOB)!, WB.signer, WB.source)
    expect(await codeOf(accept(m.db, room, sideOf(room, ALICE)!, room.room.version, true))).toBe("409:empty")
  })

  it("unaccept withdraws one side and unlocks an accepted room", async () => {
    const two = await twoSided()
    const { m } = two
    let room = two.room
    room = await setItems(m.db, room, sideOf(room, ALICE)!, [item("1")])
    const v = room.room.version
    room = await accept(m.db, room, sideOf(room, ALICE)!, v, true)
    room = await accept(m.db, room, sideOf(room, BOB)!, v, true)
    expect(room.room.status).toBe("accepted")
    room = await unaccept(m.db, room, sideOf(room, BOB)!)
    expect(room.room.status).toBe("building")
    expect(sideOf(room, BOB)!.accepted_version).toBeNull()
    expect(sideOf(room, ALICE)!.accepted_version).toBe(v)
  })

  it("signing freezes the proposal; sealed and cancelled are terminal", async () => {
    const two = await twoSided()
    const { m } = two
    let room = two.room
    room = await setItems(m.db, room, sideOf(room, ALICE)!, [item("1")])
    const v = room.room.version
    // signing needs an accepted room
    expect(await codeOf(markSigning(m.db, room))).toBe("409:stale")
    room = await accept(m.db, room, sideOf(room, ALICE)!, v, true)
    room = await accept(m.db, room, sideOf(room, BOB)!, v, true)
    await markSigning(m.db, room)
    room = await loadRoom(m.db, room.room.code)
    expect(room.room.status).toBe("signing")
    expect(await codeOf(setItems(m.db, room, sideOf(room, BOB)!, [item("2")]))).toBe("409:signing")
    expect(await codeOf(unaccept(m.db, room, sideOf(room, BOB)!))).toBe("409:signing")
    const tx = "a".repeat(64)
    room = await markSealed(m.db, room, tx, [{ id: "1", to: WB.source, held: true }])
    expect(room.room.status).toBe("sealed")
    expect(room.room.tx_id).toBe(tx)
    expect(await codeOf(cancelRoom(m.db, room, ALICE, null))).toBe("409:sealed")
    expect(await codeOf(markSealed(m.db, room, "nothex", null))).toBe("400:bad_tx")
  })

  it("either side can cancel before the seal, with a bounded reason", async () => {
    const { m, room } = await twoSided()
    const r = await cancelRoom(m.db, room, BOB, " changed   my mind ".repeat(30))
    expect(r.room.status).toBe("cancelled")
    expect(r.room.cancelled_by).toBe(BOB)
    expect(r.room.cancel_reason!.length).toBeLessThanOrEqual(200)
    expect(await codeOf(setItems(m.db, r, sideOf(r, ALICE)!, [item("1")]))).toBe("409:cancelled")
  })

  it("an expired room refuses every edit", async () => {
    const { m, room } = await twoSided()
    const later = Date.parse(room.room.expires_at) + 1
    expect(await codeOf(setItems(m.db, room, sideOf(room, ALICE)!, [item("1")], later))).toBe("409:expired")
    expect(await codeOf(joinRoom(m.db, { ...room, sides: [room.sides[0]] }, BOB, later))).toBe("409:expired")
  })

  it("listRooms shows each room from the caller's own side", async () => {
    const two = await twoSided()
    const { m } = two
    let room = two.room
    room = await setItems(m.db, room, sideOf(room, ALICE)!, [item("1"), item("2")])
    room = await setItems(m.db, room, sideOf(room, BOB)!, [item("9")])
    expect(room.items).toHaveLength(3)
    const mine = await listRooms(m.db, ALICE)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ side: "a", gives: 2, gets: 1, counterparty_present: true, status: "building" })
    const his = await listRooms(m.db, BOB)
    expect(his[0]).toMatchObject({ side: "b", gives: 1, gets: 2 })
    expect(await listRooms(m.db, "cccccccc-0000-4000-8000-000000000003")).toEqual([])
  })
})

describe("trade-room/view — what a viewer sees", () => {
  it("names users by username (never id), marks the viewer's side, and never carries the confidence tier", async () => {
    const two = await twoSided()
    const { m } = two
    let room = two.room
    room = await setItems(m.db, room, sideOf(room, ALICE)!, [item("1", 12.5), item("2", null)])
    m.tables.profile_bio = [{ user_id: ALICE, username: "webz_80" }]
    const names = await usernamesFor(m.db, room.sides.map((s) => s.user_id))
    const view = buildRoomView(room, BOB, names, { env: {} })
    expect(view.a.username).toBe("webz_80")
    expect(view.b?.username).toBe("A collector")
    expect(view.b?.is_me).toBe(true)
    expect(view.me).toEqual({ side: "b", notice_read: false })
    expect(view.a.items.map((i) => [i.fmv_usd, i.priced])).toEqual([
      [12.5, true],
      [null, false],
    ])
    expect(JSON.stringify(view)).not.toMatch(/HIGH|MEDIUM|LOW|confidence/)
    expect(JSON.stringify(view)).not.toContain(ALICE)
    // the on-chain step is closed until the env says otherwise
    expect(view.execution.open).toBe(false)
    expect(view.execution.message).toMatch(/Signing is paused on RPC right now/)
    expect(buildRoomView(room, BOB, names, { env: { RPC_TRADE_ROOM_EXECUTE: "1" } }).execution).toEqual({ open: true, message: null })
  })

  it("a stranger may join an open one-sided room, and nobody else", async () => {
    const m = memorySupabase({}, UNIQUES, DEFAULTS)
    const room = await createRoom(m.db, ALICE)
    const names = new Map<string, string>()
    expect(buildRoomView(room, BOB, names).can_join).toBe(true)
    expect(buildRoomView(room, ALICE, names).can_join).toBe(false)
    const joined = await joinRoom(m.db, room, BOB)
    expect(buildRoomView(joined, "cccccccc-0000-4000-8000-000000000003", names).can_join).toBe(false)
  })
})

describe("trade-room/valuation — the fair-trade hint", () => {
  it("counts only priced moments, names the unpriced, and gives a verdict only when every moment is priced", () => {
    const a = [{ moment_id: "1", fmv_usd: 10 }, { moment_id: "2", fmv_usd: 2.5 }]
    const b = [{ moment_id: "9", fmv_usd: 5 }]
    const even = valueTrade(a, b)
    expect(even.a).toMatchObject({ count: 2, priced: 2, unpriced: 0, priced_total_usd: 12.5, complete: true })
    expect(even.difference_usd).toBe(7.5)
    expect(even.summary).toBe("Side A gives $7.50 more by RPC's FMV.")
    const partial = valueTrade(a, [{ moment_id: "9", fmv_usd: null }])
    expect(partial.b).toMatchObject({ count: 1, priced: 0, unpriced: 1, priced_total_usd: null, complete: false })
    // no verdict over an unpriced moment — never "$0"
    expect(partial.difference_usd).toBeNull()
    expect(partial.summary).toMatch(/1 Moment not priced/)
    expect(partial.summary).not.toMatch(/\$0/)
    expect(valueTrade([], []).summary).toBe("Nothing on either side yet.")
    expect(valueTrade(b, b).summary).toBe("Even by RPC's FMV.")
    // one side empty but the other fully priced: still a verdict (the empty side is $0 by construction)
    expect(valueTrade([], b)).toMatchObject({ difference_usd: -5, summary: "Side B gives $5.00 more by RPC's FMV." })
  })
})

// 2026-11-07 review — races on the proposal contract. Each case replays a
// concurrent request by acting on a SNAPSHOT loaded before the other request ran.
describe("trade-room/store — concurrent requests never break the proposal contract", () => {
  it("an edit loaded BEFORE B joined never writes the room back to 'open'", async () => {
    const m = memorySupabase({}, UNIQUES, DEFAULTS)
    let room = await createRoom(m.db, ALICE)
    const beforeJoin = room
    room = await joinRoom(m.db, room, BOB) // building, version unchanged
    await setWallet(m.db, beforeJoin, sideOf(beforeJoin, ALICE)!, WA.signer, WA.source)
    const now = await loadRoom(m.db, room.room.code)
    expect(now.room.status).toBe("building")
  })

  it("an edit loaded BEFORE a cancel is refused and never revives the room", async () => {
    const { m, room } = await twoSided()
    const beforeCancel = room
    await cancelRoom(m.db, room, ALICE, null)
    expect(await codeOf(setItems(m.db, beforeCancel, sideOf(beforeCancel, ALICE)!, [item("1")]))).toBe("409:stale")
    const now = await loadRoom(m.db, room.room.code)
    expect(now.room.status).toBe("cancelled")
    expect(now.items).toHaveLength(0)
  })

  it("a STALE edit that loses the version race writes NOTHING", async () => {
    const { m, room } = await twoSided()
    const stale = room
    await setItems(m.db, room, sideOf(room, ALICE)!, [item("1")])
    expect(await codeOf(setItems(m.db, stale, sideOf(stale, ALICE)!, [item("2")]))).toBe("409:stale")
    const now = await loadRoom(m.db, room.room.code)
    expect(now.items.map((i) => i.moment_id)).toEqual(["1"])
  })

  it("two Accepts in the same instant (each loaded before the other wrote) still lock the room", async () => {
    const two = await twoSided()
    const { m } = two
    const room = await setItems(m.db, two.room, sideOf(two.room, ALICE)!, [item("1", 10)])
    const v = room.room.version
    // both requests loaded `room` (neither side accepted yet)
    await accept(m.db, room, sideOf(room, ALICE)!, v, true)
    const after = await accept(m.db, room, sideOf(room, BOB)!, v, true)
    expect(after.room.status).toBe("accepted")
  })

  it("⛔ a room whose co-signer has SIGNED can't be cancelled while signing (it may be sealing on chain)", async () => {
    const two = await twoSided()
    const { m } = two
    let room = await setItems(m.db, two.room, sideOf(two.room, ALICE)!, [item("1", 10)])
    const v = room.room.version
    room = await accept(m.db, room, sideOf(room, ALICE)!, v, true)
    room = await accept(m.db, room, sideOf(room, BOB)!, v, true)
    await markSigning(m.db, room)
    room = await loadRoom(m.db, room.room.code)
    m.tables.trade_room_relay = [{ id: "r1", room_id: room.room.id, signed_at: new Date().toISOString(), created_at: new Date().toISOString() }]
    expect(await codeOf(cancelRoom(m.db, room, BOB, null))).toBe("409:cosigned")
    expect((await loadRoom(m.db, room.room.code)).room.status).toBe("signing")
    // control: an UNSIGNED relay leaves cancel available
    m.tables.trade_room_relay = [{ id: "r1", room_id: room.room.id, signed_at: null, created_at: new Date().toISOString() }]
    expect((await cancelRoom(m.db, room, BOB, null)).room.status).toBe("cancelled")
  })

  // ⛔ 2026-11-13 review: signing_ended was the unguarded way out of "signing" — after it, cancel skipped the co-signed
  // check and the items were editable again, so an executed trade could be recorded "cancelled" or never verify.
  it("⛔ signing can't be ENDED (back to accepted) once the co-signer has signed — so cancel can't be laundered through it", async () => {
    const two = await twoSided()
    const { m } = two
    let room = await setItems(m.db, two.room, sideOf(two.room, ALICE)!, [item("1", 10)])
    const v = room.room.version
    room = await accept(m.db, room, sideOf(room, ALICE)!, v, true)
    room = await accept(m.db, room, sideOf(room, BOB)!, v, true)
    await markSigning(m.db, room)
    room = await loadRoom(m.db, room.room.code)
    m.tables.trade_room_relay = [{ id: "r1", room_id: room.room.id, signed_at: new Date().toISOString(), created_at: new Date().toISOString() }]
    expect(await codeOf(markSigningEnded(m.db, room))).toBe("409:cosigned")
    expect((await loadRoom(m.db, room.room.code)).room.status).toBe("signing")
    // and so the cancel that followed it in the attack still refuses
    expect(await codeOf(cancelRoom(m.db, await loadRoom(m.db, room.room.code), ALICE, null))).toBe("409:cosigned")
    // control: an UNSIGNED relay (wallet refused) still ends signing normally
    m.tables.trade_room_relay = [{ id: "r1", room_id: room.room.id, signed_at: null, created_at: new Date().toISOString() }]
    await markSigningEnded(m.db, room)
    expect((await loadRoom(m.db, room.room.code)).room.status).toBe("accepted")
  })

  it("a seal the chain proved is recorded even over a 'cancelled' row (the chain outranks the cancel)", async () => {
    const { m, room } = await twoSided()
    await cancelRoom(m.db, room, ALICE, null)
    const cancelled = await loadRoom(m.db, room.room.code)
    const sealed = await markSealed(m.db, cancelled, "a".repeat(64), [{ held: true }])
    expect(sealed.room.status).toBe("sealed")
  })
})

describe("trade-room/store — listRooms reads in chunks (2026-11-07 review)", () => {
  it("returns every room, newest first, across a chunk boundary", async () => {
    const m = memorySupabase({}, UNIQUES, DEFAULTS)
    for (let i = 0; i < 85; i++) await createRoom(m.db, ALICE)
    // distinct, known update times so the merge order is checkable
    m.tables.trade_rooms.forEach((r, i) => { r.updated_at = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() })
    const list = await listRooms(m.db, ALICE)
    expect(list).toHaveLength(85)
    const times = list.map((r) => r.updated_at as string)
    expect([...times].sort().reverse()).toEqual(times)
  })
})

