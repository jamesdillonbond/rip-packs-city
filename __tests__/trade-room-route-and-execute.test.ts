import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { memorySupabase, type MemoryDb } from "./helpers/memory-supabase"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import { CAN_RECEIVE_SCRIPT, SWAP_COLLECTIONS } from "@/lib/trade-room/multi-swap-cadence"
import { SwapTestError } from "@/lib/swap-test/plan"
import { encodeMessageFromSignable } from "@onflow/sdk"

// The two properties that matter most on the chain half of a trade room:
//   1. ⛔ no user wallet is asked to sign (relay_post) until RPC_TRADE_ROOM_EXECUTE=1
//      — everything up to it (join, wallet, picks, accept, simulate) works without;
//   2. a chain read that fails is a 503 + retryable, never "not held" / "locked".
// Plus: a mutation is scoped to the caller's own side, and a stranger cannot read a
// finished room.

const mem = vi.hoisted(() => ({ current: null as unknown as MemoryDb }))
const session = vi.hoisted(() => ({ user: null as { id: string } | null }))
const chain = vi.hoisted(() => ({
  holdings: vi.fn(),
  accounts: vi.fn(),
  proof: vi.fn(),
  planSwap: vi.fn(),
  verifySwap: vi.fn(),
  // every non-Top-Shot chain read (All Day / Golazos held scripts) goes through runFlowScript
  run: vi.fn(),
  // Top Shot marketplace listings of an account (2026-11-04)
  listed: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mem.current.db
  },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!session.user) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return session.user
  },
}))
vi.mock("@/lib/giveaways/topshot-holdings", async (orig) => ({ ...(await orig<typeof import("@/lib/giveaways/topshot-holdings")>()), readTopShotHoldings: chain.holdings }))
vi.mock("@/lib/trade-room/topshot-listed", async (orig) => ({ ...(await orig<typeof import("@/lib/trade-room/topshot-listed")>()), readTopShotListed: chain.listed }))
vi.mock("@/lib/giveaways/flow-script", async (orig) => ({ ...(await orig<typeof import("@/lib/giveaways/flow-script")>()), runFlowScript: chain.run }))
vi.mock("@/lib/giveaways/linked-accounts", () => ({ discoverAccounts: chain.accounts }))
vi.mock("@/lib/giveaways/claim-proof", async (orig) => ({ ...(await orig<typeof import("@/lib/giveaways/claim-proof")>()), verifyClaimProof: chain.proof }))
vi.mock("@/lib/swap-test/plan", async (orig) => ({ ...(await orig<typeof import("@/lib/swap-test/plan")>()), planSwap: chain.planSwap, verifySwap: chain.verifySwap }))
// The counterparty notices are fire-and-forget; here they are recorded, never sent.
const notices = vi.hoisted(() => ({ sent: [] as Array<{ actor: string; notice: string; code: string }> }))
vi.mock("@/lib/trade-room/notify", () => ({
  notifyOtherSide: async (_db: unknown, loaded: { room: { code: string } }, actor: string, notice: string) => {
    notices.sent.push({ actor, notice, code: loaded.room.code })
    return { status: "sent", notice, to_user: "x" }
  },
}))

import * as room from "@/app/api/trade-room/[code]/route"
import * as rooms from "@/app/api/trade-room/route"
import { checkPicks, checkRoomPicks, executionOpen, EXECUTE_CLOSED_MESSAGE, planRoom } from "@/lib/trade-room/execute"
import { TradeRoomError, type LoadedRoom } from "@/lib/trade-room/store"
import { TOP_SHOT_COLLECTION_ID, pickItems, readPicker, toPickerRow, withLiveLocks } from "@/lib/trade-room/holdings"

// 20261102205817: a moment id is unique only within a collection, so every item key includes it
const UNIQUES = { trade_rooms: [["code"]], trade_room_sides: [["room_id", "side"], ["room_id", "user_id"]], trade_room_items: [["room_id", "side", "collection", "moment_id"], ["room_id", "collection", "moment_id"]] }
const AD_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const DEFAULTS = {
  trade_rooms: { status: "open", version: 1, collection: "nba_top_shot", tx_id: null, landed: null, sealed_at: null, cancelled_by: null, cancel_reason: null },
  trade_room_sides: { signer: null, source: null, proven_at: null, accepted_version: null, notice_read_at: null },
  trade_room_relay: { signature: null, key_id: null, signed_at: null },
}
const ALICE = { id: "aaaaaaaa-0000-4000-8000-000000000001" }
const BOB = { id: "bbbbbbbb-0000-4000-8000-000000000002" }
const WA = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac" }
const WB = { signer: "0x00000000000000bb", source: "0x00000000000000bc" }

const wmc = (wallet: string, id: string, fmv: number | null, conf: string | null) => ({
  collection_id: TOP_SHOT_COLLECTION_ID,
  wallet_address: wallet,
  moment_id: id,
  edition_key: "1:2",
  serial_number: Number(id),
  player_name: `Player ${id}`,
  set_name: "Set",
  tier: "COMMON",
  series_number: 8,
  image_url: null,
  fmv_usd: fmv,
  fmv_confidence: conf,
  is_locked: false,
})

const get = (path: string) => new NextRequest(`http://x${path}`)
const post = (path: string, body: unknown) => new NextRequest(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const ctx = (code: string) => ({ params: Promise.resolve({ code }) })

async function as<T>(who: { id: string } | null, f: () => Promise<T>): Promise<T> {
  session.user = who
  try {
    return await f()
  } finally {
    session.user = null
  }
}

/** A two-sided room with wallets proven, built through the routes. */
async function twoSided(): Promise<string> {
  const created = await as(ALICE, () => rooms.POST(post("/api/trade-room", {})))
  const code = ((await created.json()) as { room: { code: string } }).room.code
  await as(BOB, () => room.POST(post(`/api/trade-room/${code}`, { action: "join" }), ctx(code)))
  for (const [who, w] of [[ALICE, WA], [BOB, WB]] as const) {
    chain.proof.mockResolvedValueOnce({ ok: true, address: w.signer })
    chain.accounts.mockResolvedValueOnce([
      { address: w.signer, role: "flow_wallet", name: null, dapper: false, topshot_count: 0 },
      { address: w.source, role: "linked", name: "Dapper Wallet", dapper: true, topshot_count: 10 },
    ])
    const r = await as(who, () => room.POST(post(`/api/trade-room/${code}`, { action: "wallet", proof: { x: 1 }, source: w.source }), ctx(code)))
    expect(r.status).toBe(200)
  }
  return code
}

/** The chain's default answers: every account can receive every collection; a held script holds what it is asked. */
const receives = vi.hoisted(() => ({ byAddress: {} as Record<string, boolean[]> }))
/** On-chain collection ids per `${address}|${collection_id}`; unset = whatever wmc holds for it (null = no collection). */
const onChain = vi.hoisted(() => ({ ids: {} as Record<string, string[] | null> }))
async function defaultRun(script: string, args: Array<{ value: unknown }>) {
  if (script.includes("getIDs()")) {
    const address = String(args[0].value)
    const col = SWAP_COLLECTIONS.find((c) => script.includes(c.public))!
    const key = `${address}|${col.collectionId}`
    const ids = key in onChain.ids ? onChain.ids[key] : (mem.current.tables.wallet_moments_cache ?? []).filter((r) => r.wallet_address === address && r.collection_id === col.collectionId).map((r) => String(r.moment_id))
    return { type: "Optional", value: ids === null ? null : { type: "Array", value: ids.map((v) => ({ type: "UInt64", value: v })) } }
  }
  if (script === CAN_RECEIVE_SCRIPT) return { type: "Array", value: (receives.byAddress[String(args[0].value)] ?? [true, true, true, true]).map((v) => ({ type: "Bool", value: v })) }
  return { type: "Array", value: (args[1].value as Array<{ value: string }>).map((x) => ({ type: "UInt64", value: x.value })) }
}

beforeEach(() => {
  receives.byAddress = {}
  onChain.ids = {}
  mem.current = memorySupabase({ wallet_moments_cache: [wmc(WA.source, "1", 10, "HIGH"), wmc(WA.source, "2", 3, "LOW"), wmc(WB.source, "9", 5, "MEDIUM")], profile_bio: [] }, UNIQUES, DEFAULTS)
  chain.holdings.mockImplementation(async (_a: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }])))
  chain.run.mockImplementation(defaultRun)
  chain.listed.mockImplementation(async () => new Set<string>())
  room.__resetProofRateLimit()
  notices.sent.length = 0
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("trade-room/execute — the gate and the chain reads", () => {
  it("the on-chain step is closed unless RPC_TRADE_ROOM_EXECUTE is exactly '1'", () => {
    expect(executionOpen({})).toBe(false)
    expect(executionOpen({ RPC_TRADE_ROOM_EXECUTE: "true" })).toBe(false)
    expect(executionOpen({ RPC_TRADE_ROOM_EXECUTE: "1" })).toBe(true)
    expect(EXECUTE_CLOSED_MESSAGE).toMatch(/Nothing has moved/)
  })

  it("checkPicks: a failed chain read is a 503, never 'not held'; a real miss or lock is named", async () => {
    await expect(checkPicks("0x00000000000000aa", ["1"], async () => { throw new Error("Flow script HTTP 503") })).rejects.toMatchObject({ status: 503, code: "upstream_unavailable" })
    await expect(checkPicks("0x00000000000000aa", ["1", "2"], async () => ({ "1": { held: true, locked: false } }))).rejects.toMatchObject({ code: "not_held", message: expect.stringContaining("2") })
    await expect(checkPicks("0x00000000000000aa", ["1"], async () => ({ "1": { held: true, locked: true } }))).rejects.toMatchObject({ code: "locked" })
    // an unknown lock state is not "unlocked"
    await expect(checkPicks("0x00000000000000aa", ["1"], async () => ({ "1": { held: true, locked: null } }))).rejects.toMatchObject({ code: "locked" })
    await expect(checkPicks("0x00000000000000aa", [], async () => { throw new Error("never called") })).resolves.toBeUndefined()
  })

  it("planRoom needs an accepted room and puts the initiator as side A of the plan", async () => {
    const loaded = {
      room: { status: "accepted", version: 3 },
      sides: [
        { side: "a", signer: WA.signer, source: WA.source },
        { side: "b", signer: WB.signer, source: WB.source },
      ],
      items: [{ side: "a", moment_id: "1" }, { side: "b", moment_id: "9" }],
    } as unknown as LoadedRoom
    chain.planSwap.mockImplementation(async (a: unknown, b: unknown) => ({ a, b }))
    const p = await planRoom(loaded, "b")
    expect(p.a).toMatchObject({ signer: WB.signer, source: WB.source, ids: ["9"] })
    expect(p.b).toMatchObject({ signer: WA.signer, ids: ["1"] })
    await expect(planRoom({ ...loaded, room: { ...loaded.room, status: "building" } } as LoadedRoom, "a")).rejects.toMatchObject({ code: "not_accepted" })
    // a SwapTestError keeps its status and code
    chain.planSwap.mockRejectedValueOnce(new SwapTestError("locked", 409, "locked"))
    await expect(planRoom(loaded, "a")).rejects.toMatchObject({ status: 409, code: "locked" })
  })

  it("a Top Shot Moment listed for sale never reaches a plan, by name; a failed listed read is a 503 (2026-11-04)", async () => {
    const loaded = {
      room: { status: "accepted", version: 3 },
      sides: [
        { side: "a", signer: WA.signer, source: WA.source },
        { side: "b", signer: WB.signer, source: WB.source },
      ],
      items: [{ side: "a", moment_id: "1" }, { side: "b", moment_id: "9" }],
    } as unknown as LoadedRoom
    chain.planSwap.mockImplementation(async (a: unknown, b: unknown) => ({ a, b }))
    chain.listed.mockImplementation(async (addr: string) => new Set(addr === WB.source ? ["9"] : []))
    await expect(planRoom(loaded, "a")).rejects.toMatchObject({ status: 409, code: "listed", message: expect.stringContaining("9") })
    expect(chain.planSwap).not.toHaveBeenCalled()
    chain.listed.mockImplementation(async () => { throw new Error("listed read HTTP 503") })
    await expect(planRoom(loaded, "a")).rejects.toMatchObject({ status: 503, code: "upstream_unavailable" })
    chain.listed.mockImplementation(async () => new Set<string>())
    await expect(planRoom(loaded, "a")).resolves.toBeTruthy()
  })

  it("saving picks refuses a listed Top Shot Moment; other collections are not read for listings", async () => {
    chain.listed.mockImplementation(async () => new Set(["2"]))
    await expect(checkRoomPicks(WA.source, [{ collection: "nba-top-shot", id: "1" }, { collection: "nba-top-shot", id: "2" }])).rejects.toMatchObject({ status: 409, code: "listed", message: expect.stringContaining("2") })
    await expect(checkRoomPicks(WA.source, [{ collection: "nba-top-shot", id: "1" }])).resolves.toBeUndefined()
    chain.listed.mockClear()
    onChain.ids[WA.source] = ["7"]
    await checkRoomPicks(WA.source, [{ collection: "nfl-all-day", id: "7" }]).catch(() => undefined)
    expect(chain.listed).not.toHaveBeenCalled()
  })
})

describe("trade-room/holdings — the picker", () => {
  it("prices a moment only at HIGH/MEDIUM and never leaks the tier", () => {
    expect(toPickerRow(wmc("w", "1", 10, "HIGH"))).toMatchObject({ fmv_usd: 10, priced: true })
    expect(toPickerRow(wmc("w", "1", 10, "medium"))).toMatchObject({ fmv_usd: 10, priced: true })
    expect(toPickerRow(wmc("w", "1", 10, "LOW"))).toMatchObject({ fmv_usd: null, priced: false })
    expect(toPickerRow(wmc("w", "1", null, "HIGH"))).toMatchObject({ fmv_usd: null, priced: false })
    expect(Object.keys(toPickerRow(wmc("w", "1", 10, "HIGH")))).not.toContain("fmv_confidence")
  })

  it("readPicker scopes by collection + wallet, tells an unindexed wallet from an empty filter, and pickItems refuses unknown ids", async () => {
    const r = await readPicker(mem.current.db, WA.source)
    expect(r.indexed).toBe(true)
    expect(r.rows.map((x) => x.moment_id)).toEqual(["1", "2"])
    expect((await readPicker(mem.current.db, "0x0000000000000000")).indexed).toBe(false)
    const filtered = await readPicker(mem.current.db, WA.source, "nobody")
    expect(filtered).toMatchObject({ indexed: true, rows: [] })
    const picked = pickItems(r.rows, ["2", "77"])
    expect(picked.items.map((i) => i.moment_id)).toEqual(["2"])
    expect(picked.unknown).toEqual(["77"])
    expect(Object.keys(picked.items[0])).not.toContain("priced")
  })
})

// #222 (2026-10-31): 121 of one wallet's 137 cached "unlocked" rows had been locked that morning.
describe("trade-room/holdings — live lock overlay", () => {
  const base = { indexed: true, truncated: false, rows: [toPickerRow(wmc("w", "1", 10, "HIGH")), toPickerRow(wmc("w", "2", 5, "HIGH")), toPickerRow(wmc("w", "3", 5, "HIGH"))] }
  it("replaces the cached flag with the chain's answer and names a moment that left", async () => {
    const read = vi.fn(async () => ({ "1": { held: true, locked: true }, "2": { held: true, locked: false }, "3": { held: false, locked: null } }))
    const r = await withLiveLocks(base, "0x00000000000000aa", read)
    expect(r.lock_state).toBe("live")
    expect(r.rows.map((x) => [x.moment_id, x.locked_hint, x.held_live])).toEqual([["1", true, true], ["2", false, true], ["3", base.rows[2].locked_hint, false]])
    expect(read).toHaveBeenCalledWith("0x00000000000000aa", ["1", "2", "3"])
  })
  it("a failed or slow chain read keeps the cached hint and SAYS so — never 'unlocked'", async () => {
    const failed = await withLiveLocks(base, "0x00000000000000aa", async () => { throw new Error("Flow script HTTP 503") })
    expect(failed.lock_state).toBe("cached")
    expect(failed.rows).toEqual(base.rows)
    const slow = await withLiveLocks(base, "0x00000000000000aa", () => new Promise(() => {}), 5)
    expect(slow.lock_state).toBe("cached")
  })
  it("marks a Moment listed on Top Shot; a failed listed read leaves rows unmarked, still live", async () => {
    const read = vi.fn(async () => ({ "1": { held: true, locked: false }, "2": { held: true, locked: false }, "3": { held: false, locked: null } }))
    const r = await withLiveLocks(base, "0x00000000000000aa", read, 12_000, async () => new Set(["2"]))
    expect(r.lock_state).toBe("live")
    expect(r.rows.map((x) => [x.moment_id, x.listed_live])).toEqual([["1", false], ["2", true], ["3", undefined]])
    const down = await withLiveLocks(base, "0x00000000000000aa", read, 12_000, async () => { throw new Error("listed read HTTP 503") })
    expect(down.lock_state).toBe("live")
    expect(down.rows.every((x) => x.listed_live === undefined)).toBe(true)
  })
  it("pickItems never stores the live-read fields", () => {
    const picked = pickItems([{ ...base.rows[0], held_live: true, listed_live: true }], ["1"])
    expect(Object.keys(picked.items[0])).not.toContain("held_live")
    expect(Object.keys(picked.items[0])).not.toContain("locked_hint")
    expect(Object.keys(picked.items[0])).not.toContain("listed_live")
  })
})

describe("/api/trade-room — the routes", () => {
  it("refuses anon on both routes", async () => {
    expect((await rooms.GET(get("/api/trade-room"))).status).toBe(401)
    expect((await room.POST(post("/api/trade-room/abcdefghij", { action: "join" }), ctx("abcdefghij"))).status).toBe(401)
  })

  it("picks are chain-checked and scoped to the caller's own side; a chain outage is 503 + retryable", async () => {
    const code = await twoSided()
    chain.holdings.mockRejectedValueOnce(new Error("Flow script HTTP 503"))
    const down = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", ids: ["1"] }), ctx(code)))
    expect(down.status).toBe(503)
    expect(await down.json()).toMatchObject({ code: "upstream_unavailable", retryable: true })
    const ok = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", ids: ["1", "2"] }), ctx(code)))
    expect(ok.status).toBe(200)
    const v = (await ok.json()) as { room: { a: { items: Array<{ moment_id: string; priced: boolean; fmv_usd: number | null }> } } }
    expect(v.room.a.items).toEqual([expect.objectContaining({ moment_id: "1", priced: true, fmv_usd: 10 }), expect.objectContaining({ moment_id: "2", priced: false, fmv_usd: null })])
    expect(chain.holdings).toHaveBeenLastCalledWith(WA.source, ["1", "2"])
    // Bob cannot pick from Alice's account: his picks are read from HIS source
    const bob = await as(BOB, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", ids: ["1"] }), ctx(code)))
    expect(bob.status).toBe(409)
    expect(await bob.json()).toMatchObject({ code: "not_indexed" })
    // a stranger is not in the room
    const stranger = await as({ id: "cccccccc-0000-4000-8000-000000000003" }, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", ids: ["9"] }), ctx(code)))
    expect(stranger.status).toBe(403)
  })

  it("more picks than a side may hold are refused BEFORE any wallet-cache or chain read (2026-11-07 review)", async () => {
    const code = await twoSided()
    chain.holdings.mockClear()
    chain.run.mockClear()
    const ids = Array.from({ length: 11 }, (_, i) => String(i + 1))
    const r = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", ids }), ctx(code)))
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ code: "too_many" })
    expect(chain.holdings).not.toHaveBeenCalled()
    expect(chain.run).not.toHaveBeenCalled()
  })

  it("⛔ relay_post is refused while the flag is unset, after both accepted and the simulation passed; opens with the flag", async () => {
    const code = await twoSided()
    await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", ids: ["1"] }), ctx(code)))
    const seen = await as(BOB, () => room.GET(get(`/api/trade-room/${code}`), ctx(code)))
    const version = ((await seen.json()) as { room: { version: number } }).room.version
    for (const who of [ALICE, BOB]) {
      const r = await as(who, () => room.POST(post(`/api/trade-room/${code}`, { action: "accept", version, notice_read: true }), ctx(code)))
      expect(r.status).toBe(200)
    }
    const accepted = (await (await as(ALICE, () => room.GET(get(`/api/trade-room/${code}`), ctx(code)))).json()) as { room: { state: string; execution: { open: boolean } } }
    expect(accepted.room.state).toBe("accepted")
    // the other side was told at each step: Bob joined → Alice; Alice accepted → Bob's turn; Bob accepted → Alice, ready
    await new Promise((r) => setTimeout(r, 0))
    expect(notices.sent.map((n) => `${n.actor === ALICE.id ? "alice" : "bob"}:${n.notice}`)).toEqual(["bob:joined", "alice:accepted", "bob:ready"])
    expect(accepted.room.execution.open).toBe(false)
    // the simulation is a READ and runs regardless of the gate
    chain.planSwap.mockResolvedValueOnce({ a: { signer: WA.signer, source: WA.source, ids: ["1"], kind: "linked", ctl: "87" }, b: { signer: WB.signer, source: WB.source, ids: [], kind: "linked", ctl: "4" } })
    expect((await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "simulate" }), ctx(code)))).status).toBe(200)
    // CISO 2026-11-04 (relay-guard): the signable must BE this room's trade — Alice gives Top Shot 1,
    // Bob gives nothing — with Alice proposing/paying and Bob the second authorizer, and `message`
    // must be FCL's encoding of that voucher for Bob.
    const voucher = {
      cadence: SWAP_CADENCE,
      authorizers: [WA.signer, WB.signer],
      payer: WA.signer,
      proposalKey: { address: WA.signer, keyId: 0, sequenceNum: 1 },
      refBlock: "ab",
      computeLimit: 9999,
      arguments: [
        { type: "Address", value: WA.source },
        { type: "UInt64", value: "0" },
        { type: "Array", value: [{ type: "UInt64", value: "1" }] },
        { type: "Address", value: WB.source },
        { type: "UInt64", value: "0" },
        { type: "Array", value: [] },
      ],
      payloadSigs: [],
    }
    const signable: Record<string, unknown> = { cadence: SWAP_CADENCE, addr: WB.signer, args: voucher.arguments, voucher, roles: { authorizer: true } }
    signable.message = encodeMessageFromSignable(signable as never, WB.signer)
    const closed = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "relay_post", cosigner: WB.signer, signable }), ctx(code)))
    expect(closed.status).toBe(503)
    expect(await closed.json()).toMatchObject({ code: "execute_closed" })
    expect(mem.current.tables.trade_room_relay ?? []).toEqual([])
    expect(mem.current.tables.trade_rooms[0].status).toBe("accepted")
    vi.stubEnv("RPC_TRADE_ROOM_EXECUTE", "1")
    // the co-signer must be the other side's proven wallet
    const wrong = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "relay_post", cosigner: "0x00000000000000ee", signable }), ctx(code)))
    expect(wrong.status).toBe(400)
    // the pre-11-04 shape (cadence + hex message, no voucher) is refused: it could carry ANY ids
    const bare = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "relay_post", cosigner: WB.signer, signable: { cadence: SWAP_CADENCE, message: "ab", addr: WB.signer } }), ctx(code)))
    expect(bare.status).toBe(400)
    expect(await bare.json()).toMatchObject({ code: "bad_voucher" })
    // and so is the real voucher with one extra Moment of Bob's slipped into his side (the H1 attack)
    const tampered = { ...voucher, arguments: voucher.arguments.map((a, i) => (i === 5 ? { type: "Array", value: [{ type: "UInt64", value: "777" }] } : a)) }
    const tamperedSignable: Record<string, unknown> = { ...signable, args: tampered.arguments, voucher: tampered }
    tamperedSignable.message = encodeMessageFromSignable(tamperedSignable as never, WB.signer)
    const stolen = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "relay_post", cosigner: WB.signer, signable: tamperedSignable }), ctx(code)))
    expect(stolen.status).toBe(400)
    expect(await stolen.json()).toMatchObject({ code: "wrong_items" })
    expect(mem.current.tables.trade_room_relay ?? []).toEqual([])
    const open = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "relay_post", cosigner: WB.signer, signable }), ctx(code)))
    expect(open.status).toBe(200)
    expect(mem.current.tables.trade_rooms[0].status).toBe("signing")
    expect(mem.current.tables.trade_room_relay).toHaveLength(1)
    // Bob sees the pending relay on his view; Alice does not
    const bobView = (await (await as(BOB, () => room.GET(get(`/api/trade-room/${code}`), ctx(code)))).json()) as { room: { relay: { cosigner: string } | null } }
    expect(bobView.room.relay?.cosigner).toBe(WB.signer)
    const aliceView = (await (await as(ALICE, () => room.GET(get(`/api/trade-room/${code}`), ctx(code)))).json()) as { room: { relay: unknown } }
    expect(aliceView.room.relay).toBeNull()
    // only the co-signer may post the signature
    const id = mem.current.tables.trade_room_relay[0].id as string
    const sig = { action: "relay_sign", id, signature: "a".repeat(128), key_id: 0 }
    expect((await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, sig), ctx(code)))).status).toBe(403)
    expect((await as(BOB, () => room.POST(post(`/api/trade-room/${code}`, sig), ctx(code)))).status).toBe(200)

    // CISO 2026-11-04 (trade-room finding M1): "sealed" is a CHAIN fact, never a claim.
    const txId = "f".repeat(64)
    // (a) the chain can't be read → 503, nothing sealed
    chain.verifySwap.mockRejectedValueOnce(new SwapTestError("access node 502", 502, "chain_unavailable"))
    const unread = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "sealed", tx_id: txId }), ctx(code)))
    expect(unread.status).toBe(503)
    expect(mem.current.tables.trade_rooms[0].status).toBe("signing")
    // (b) the chain says the Moment is still where it was → 409, nothing sealed
    chain.verifySwap.mockResolvedValueOnce([{ id: "1", to: WB.source, held: false }])
    const notYet = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "sealed", tx_id: txId }), ctx(code)))
    expect(notYet.status).toBe(409)
    expect(await notYet.json()).toMatchObject({ code: "not_landed" })
    expect(mem.current.tables.trade_rooms[0].tx_id).toBeNull()
    // (c) the chain confirms every Moment moved → sealed, with the tx id
    chain.verifySwap.mockResolvedValueOnce([{ id: "1", to: WB.source, held: true }])
    const sealed = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "sealed", tx_id: txId }), ctx(code)))
    expect(sealed.status).toBe(200)
    expect(await sealed.json()).toMatchObject({ verified: true })
    expect(mem.current.tables.trade_rooms[0]).toMatchObject({ status: "sealed", tx_id: txId })
    // (d) a second claim with another tx id never overwrites the first
    const again = await as(BOB, () => room.POST(post(`/api/trade-room/${code}`, { action: "sealed", tx_id: "e".repeat(64) }), ctx(code)))
    expect(again.status).toBe(200)
    expect(mem.current.tables.trade_rooms[0].tx_id).toBe(txId)
  })

  it("a stranger cannot read a finished room; a cancelled room reads as cancelled", async () => {
    const code = await twoSided()
    const stranger = { id: "cccccccc-0000-4000-8000-000000000003" }
    expect((await as(stranger, () => room.GET(get(`/api/trade-room/${code}`), ctx(code)))).status).toBe(404)
    const cancelled = await as(BOB, () => room.POST(post(`/api/trade-room/${code}`, { action: "cancel", reason: "changed my mind" }), ctx(code)))
    expect(((await cancelled.json()) as { room: { state: string; cancel_reason: string } }).room).toMatchObject({ state: "cancelled", cancel_reason: "changed my mind" })
  })

  it("the proof check rate-limits per user and a bad proof is a 400 with the route's reason", async () => {
    const code = await twoSided()
    chain.proof.mockResolvedValue({ ok: false, code: "proof_invalid", error: "Flow didn't confirm that sign-in came from that wallet." })
    const r = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "wallet", proof: {} }), ctx(code)))
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ code: "proof_invalid" })
    for (let i = 0; i < 12; i++) await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "wallet", proof: {} }), ctx(code)))
    const limited = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "wallet", proof: {} }), ctx(code)))
    expect(limited.status).toBe(429)
  })

  it("All Day and Top Shot picks with the SAME moment id are two moments, each read and stored under its own collection", async () => {
    // Alice's account holds Top Shot #1 (seeded) and All Day #1 — the same id in another collection
    mem.current.tables.wallet_moments_cache.push({ ...wmc(WA.source, "1", 7, "HIGH"), collection_id: AD_COLLECTION_ID, player_name: "Josh Allen" })
    const code = await twoSided()
    const r = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "nba-top-shot", id: "1" }, { collection: "nfl-all-day", id: "1" }] }), ctx(code)))
    expect(r.status).toBe(200)
    const v = (await r.json()) as { room: { collection: string; a: { items: Array<{ collection: string; moment_id: string; player_name: string }> } } }
    expect(v.room.a.items.map((i) => `${i.collection}:${i.moment_id}:${i.player_name}`).sort()).toEqual(["nba_top_shot:1:Player 1", "nfl_all_day:1:Josh Allen"])
    expect(v.room.collection).toBe("mixed")
    // the Top Shot read saw only the Top Shot id; the All Day read went through the chain script
    expect(chain.holdings).toHaveBeenLastCalledWith(WA.source, ["1"])
    expect(chain.run.mock.calls.filter((c) => String(c[0]).includes("import AllDay from 0xe4cf4bdc1751c65d"))).toHaveLength(1)
    // and the other side's account was asked whether it can receive what was picked
    expect(chain.run.mock.calls.filter((c) => c[0] === CAN_RECEIVE_SCRIPT).map((c) => (c[1] as Array<{ value: string }>)[0].value)).toEqual([WB.source])
  })

  it("an All Day pick the chain says is gone is named; a failed All Day read is a 503, never 'not held'", async () => {
    mem.current.tables.wallet_moments_cache.push({ ...wmc(WA.source, "5", 7, "HIGH"), collection_id: AD_COLLECTION_ID })
    const code = await twoSided()
    chain.run.mockResolvedValueOnce({ type: "Array", value: [] })
    const gone = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "nfl-all-day", id: "5" }] }), ctx(code)))
    expect(gone.status).toBe(409)
    expect(await gone.json()).toMatchObject({ code: "not_held" })
    chain.run.mockRejectedValueOnce(new Error("Flow script HTTP 503"))
    const down = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "nfl-all-day", id: "5" }] }), ctx(code)))
    expect(down.status).toBe(503)
    const body = (await down.json()) as { code: string; error: string }
    expect(body.code).toBe("upstream_unavailable")
    expect(body.error).not.toMatch(/doesn't hold/)
    expect(mem.current.tables.trade_room_items ?? []).toEqual([])
  })

  it("a pick the other side's account cannot RECEIVE is refused on save, naming the collection; a failed check is a 503", async () => {
    mem.current.tables.wallet_moments_cache.push({ ...wmc(WA.source, "5", 7, "HIGH"), collection_id: AD_COLLECTION_ID })
    const code = await twoSided()
    receives.byAddress[WB.source] = [true, false, true, true]
    const no = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "nfl-all-day", id: "5" }] }), ctx(code)))
    expect(no.status).toBe(409)
    const body = (await no.json()) as { code: string; error: string }
    expect(body.code).toBe("cannot_receive")
    expect(body.error).toMatch(/0x00000000000000bc has no NFL All Day collection/)
    expect(mem.current.tables.trade_room_items ?? []).toEqual([])
    // a Top Shot pick to the same account is fine
    expect((await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "nba-top-shot", id: "1" }] }), ctx(code)))).status).toBe(200)
    // the receiver check could not be read: 503, never "can't receive"
    chain.run.mockImplementation(async (script: string, args: Array<{ value: unknown }>) => {
      if (script === CAN_RECEIVE_SCRIPT) throw new Error("Flow script HTTP 503")
      return defaultRun(script, args)
    })
    const down = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "nfl-all-day", id: "5" }] }), ctx(code)))
    expect(down.status).toBe(503)
    expect(((await down.json()) as { error: string }).error).not.toMatch(/can't receive/)
  })

  it("switching to an account that can't receive what the other side already picked is refused, naming it", async () => {
    mem.current.tables.wallet_moments_cache.push({ ...wmc(WA.source, "5", 7, "HIGH"), collection_id: AD_COLLECTION_ID })
    const code = await twoSided()
    expect((await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "nfl-all-day", id: "5" }] }), ctx(code)))).status).toBe(200)
    const bobOther = "0x00000000000000bd"
    receives.byAddress[bobOther] = [true, false, true, true]
    chain.proof.mockResolvedValueOnce({ ok: true, address: WB.signer })
    chain.accounts.mockResolvedValueOnce([
      { address: WB.signer, role: "flow_wallet", name: null, dapper: false, topshot_count: 0 },
      { address: WB.source, role: "linked", name: "Dapper Wallet", dapper: true, topshot_count: 10 },
      { address: bobOther, role: "linked", name: "Other", dapper: true, topshot_count: 3 },
    ])
    const r = await as(BOB, () => room.POST(post(`/api/trade-room/${code}`, { action: "wallet", proof: { x: 1 }, source: bobOther }), ctx(code)))
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: "cannot_receive" })
    expect(mem.current.tables.trade_room_sides.find((x) => x.side === "b")?.source).toBe(WB.source)
  })

  it("the All Day picker shows what is in the ON-CHAIN collection, and COUNTS what RPC lists that is not (locked / studio-held)", async () => {
    // RPC lists three All Day Moments for Alice's account; only one is in its on-chain collection
    for (const id of ["21", "22", "23"]) mem.current.tables.wallet_moments_cache.push({ ...wmc(WA.source, id, 7, "HIGH"), collection_id: AD_COLLECTION_ID, player_name: `AD ${id}` })
    const code = await twoSided()
    onChain.ids[`${WA.source}|${AD_COLLECTION_ID}`] = ["22", "99"] // 99: held, but RPC hasn't indexed it
    const r = await as(ALICE, () => room.GET(get(`/api/trade-room/${code}?picker=1&collection=nfl-all-day`), ctx(code)))
    const p = ((await r.json()) as { picker: { rows: Array<{ moment_id: string }>; not_in_collection: number; unindexed_held: number; lock_state: string } }).picker
    expect(p.rows.map((x) => x.moment_id)).toEqual(["22"])
    expect(p).toMatchObject({ not_in_collection: 2, unindexed_held: 1, lock_state: "live" })
    // an account with no All Day collection says so — never "holds nothing"
    onChain.ids[`${WA.source}|${AD_COLLECTION_ID}`] = null
    const none = (await (await as(ALICE, () => room.GET(get(`/api/trade-room/${code}?picker=1&collection=nfl-all-day`), ctx(code)))).json()) as { picker: { no_collection: boolean; rows: unknown[] } }
    expect(none.picker).toMatchObject({ no_collection: true, rows: [] })
  })

  it("a failed chain read on the All Day picker falls back to RPC's list, labelled cached — never an empty picker", async () => {
    mem.current.tables.wallet_moments_cache.push({ ...wmc(WA.source, "21", 7, "HIGH"), collection_id: AD_COLLECTION_ID, player_name: "AD 21" })
    const code = await twoSided()
    chain.run.mockImplementation(async (script: string, args: Array<{ value: unknown }>) => {
      if (script.includes("getIDs()")) throw new Error("Flow script HTTP 503")
      return defaultRun(script, args)
    })
    const r = await as(ALICE, () => room.GET(get(`/api/trade-room/${code}?picker=1&collection=nfl-all-day`), ctx(code)))
    expect(r.status).toBe(200)
    const p = ((await r.json()) as { picker: { rows: Array<{ moment_id: string }>; lock_state: string } }).picker
    expect(p.lock_state).toBe("cached")
    expect(p.rows.map((x) => x.moment_id)).toEqual(["21"])
  })

  it("?receive=1 says, per proven side, which collections its account can receive; a failed read is a 503", async () => {
    const code = await twoSided()
    receives.byAddress[WB.source] = [true, false, true, true]
    const r = await as(ALICE, () => room.GET(get(`/api/trade-room/${code}?receive=1`), ctx(code)))
    expect(r.status).toBe(200)
    expect(((await r.json()) as { receive: unknown }).receive).toEqual({
      a: { "nba-top-shot": true, "nfl-all-day": true, "laliga-golazos": true, ufc: true },
      b: { "nba-top-shot": true, "nfl-all-day": false, "laliga-golazos": true, ufc: true },
    })
    // only the two sides may ask
    expect((await as({ id: "cccccccc-0000-4000-8000-000000000003" }, () => room.GET(get(`/api/trade-room/${code}?receive=1`), ctx(code)))).status).toBe(403)
    chain.run.mockImplementation(async (script: string, args: Array<{ value: unknown }>) => {
      if (script === CAN_RECEIVE_SCRIPT) throw new Error("Flow script HTTP 503")
      return defaultRun(script, args)
    })
    const down = await as(ALICE, () => room.GET(get(`/api/trade-room/${code}?receive=1`), ctx(code)))
    expect(down.status).toBe(503)
    expect(JSON.stringify(await down.json())).not.toMatch(/false/)
  })

  it("an unknown collection is refused — on the picker and on save — never answered with Top Shot", async () => {
    const code = await twoSided()
    const picker = await as(ALICE, () => room.GET(get(`/api/trade-room/${code}?picker=1&collection=candy_mlb`), ctx(code)))
    expect(picker.status).toBe(400)
    const body = JSON.stringify(await picker.json())
    expect(body).not.toMatch(/Player 1/)
    const save = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "items", picks: [{ collection: "disney-pinnacle", id: "1" }] }), ctx(code)))
    expect(save.status).toBe(400)
    expect(await save.json()).toMatchObject({ code: "bad_collection" })
  })

  it("the picker reads the collection asked for, scoped by its collection_id", async () => {
    mem.current.tables.wallet_moments_cache.push({ ...wmc(WA.source, "1", 7, "HIGH"), collection_id: AD_COLLECTION_ID, player_name: "Josh Allen" })
    const code = await twoSided()
    const r = await as(ALICE, () => room.GET(get(`/api/trade-room/${code}?picker=1&collection=nfl-all-day`), ctx(code)))
    expect(r.status).toBe(200)
    const p = (await r.json()) as { picker: { rows: Array<{ collection: string; player_name: string; locked_hint: boolean | null; held_live?: boolean }>; lock_state: string } }
    expect(p.picker.rows.map((x) => `${x.collection}:${x.player_name}`)).toEqual(["nfl_all_day:Josh Allen"])
    expect(p.picker.lock_state).toBe("live")
    expect(p.picker.rows[0]).toMatchObject({ held_live: true, locked_hint: false })
  })

  it("TradeRoomError keeps its status and code through the route", async () => {
    const code = await twoSided()
    const r = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "accept", version: 999, notice_read: true }), ctx(code)))
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: "stale" })
    expect(new TradeRoomError("x", 409, "stale")).toBeInstanceOf(Error)
  })
})
