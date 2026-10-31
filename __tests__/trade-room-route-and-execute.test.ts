import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { memorySupabase, type MemoryDb } from "./helpers/memory-supabase"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import { SwapTestError } from "@/lib/swap-test/plan"

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
vi.mock("@/lib/giveaways/topshot-holdings", () => ({ readTopShotHoldings: chain.holdings }))
vi.mock("@/lib/giveaways/linked-accounts", () => ({ discoverAccounts: chain.accounts }))
vi.mock("@/lib/giveaways/claim-proof", async (orig) => ({ ...(await orig<typeof import("@/lib/giveaways/claim-proof")>()), verifyClaimProof: chain.proof }))
vi.mock("@/lib/swap-test/plan", async (orig) => ({ ...(await orig<typeof import("@/lib/swap-test/plan")>()), planSwap: chain.planSwap, verifySwap: chain.verifySwap }))

import * as room from "@/app/api/trade-room/[code]/route"
import * as rooms from "@/app/api/trade-room/route"
import { checkPicks, executionOpen, EXECUTE_CLOSED_MESSAGE, planRoom } from "@/lib/trade-room/execute"
import { TradeRoomError, type LoadedRoom } from "@/lib/trade-room/store"
import { TOP_SHOT_COLLECTION_ID, pickItems, readPicker, toPickerRow } from "@/lib/trade-room/holdings"

const UNIQUES = { trade_rooms: [["code"]], trade_room_sides: [["room_id", "side"], ["room_id", "user_id"]], trade_room_items: [["room_id", "moment_id"]] }
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

beforeEach(() => {
  mem.current = memorySupabase({ wallet_moments_cache: [wmc(WA.source, "1", 10, "HIGH"), wmc(WA.source, "2", 3, "LOW"), wmc(WB.source, "9", 5, "MEDIUM")], profile_bio: [] }, UNIQUES, DEFAULTS)
  chain.holdings.mockImplementation(async (_a: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }])))
  room.__resetProofRateLimit()
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
    expect(accepted.room.execution.open).toBe(false)
    // the simulation is a READ and runs regardless of the gate
    chain.planSwap.mockResolvedValueOnce({ a: { signer: WA.signer, source: WA.source, ids: ["1"], kind: "linked", ctl: "87" }, b: { signer: WB.signer, source: WB.source, ids: [], kind: "linked", ctl: "4" } })
    expect((await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "simulate" }), ctx(code)))).status).toBe(200)
    const signable = { cadence: SWAP_CADENCE, message: "ab", addr: WB.signer }
    const closed = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "relay_post", cosigner: WB.signer, signable }), ctx(code)))
    expect(closed.status).toBe(503)
    expect(await closed.json()).toMatchObject({ code: "execute_closed" })
    expect(mem.current.tables.trade_room_relay ?? []).toEqual([])
    expect(mem.current.tables.trade_rooms[0].status).toBe("accepted")
    vi.stubEnv("RPC_TRADE_ROOM_EXECUTE", "1")
    // the co-signer must be the other side's proven wallet
    const wrong = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "relay_post", cosigner: "0x00000000000000ee", signable }), ctx(code)))
    expect(wrong.status).toBe(400)
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

  it("TradeRoomError keeps its status and code through the route", async () => {
    const code = await twoSided()
    const r = await as(ALICE, () => room.POST(post(`/api/trade-room/${code}`, { action: "accept", version: 999, notice_read: true }), ctx(code)))
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: "stale" })
    expect(new TradeRoomError("x", 409, "stale")).toBeInstanceOf(Error)
  })
})
