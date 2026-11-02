import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { memorySupabase, type MemoryDb } from "./helpers/memory-supabase"

// The Trade Block end to end through its three routes (Trevor, 2026-11-02;
// docs/strategy/features/trading.md §3), on the in-memory store:
//   · ownership: only assets in a PROVEN account can be offered or given;
//   · public reads never carry a wallet address, and a failed read is a 503, never "no listings";
//   · no cash: a note with a payment rail is refused with the reason;
//   · signing eligibility: accepting an all-Top-Shot proposal opens a trade room for the two
//     collectors; a proposal with any other collection records the agreement only;
//   · scope: a user closes only their own listing and answers only proposals on it.

const mem = vi.hoisted(() => ({ current: null as unknown as MemoryDb }))
const session = vi.hoisted(() => ({ user: null as { id: string } | null }))
const chain = vi.hoisted(() => ({ accounts: vi.fn(), proof: vi.fn() }))
const notices = vi.hoisted(() => ({ sent: [] as Array<{ to: string; actor: string; notice: string; room: string | null | undefined }> }))

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
  getCurrentUser: async () => session.user,
}))
vi.mock("@/lib/giveaways/linked-accounts", () => ({ discoverAccounts: chain.accounts }))
vi.mock("@/lib/giveaways/claim-proof", async (orig) => ({ ...(await orig<typeof import("@/lib/giveaways/claim-proof")>()), verifyClaimProof: chain.proof }))
vi.mock("@/lib/trade-block/notify", () => ({
  notifyBlock: async (_db: unknown, to: string, actor: string, notice: string, opts: { roomCode?: string | null }) => {
    notices.sent.push({ to, actor, notice, room: opts?.roomCode })
    return { status: "sent", notice }
  },
}))

import * as signedIn from "@/app/api/trade-block/route"
import * as publicList from "@/app/api/public/trade-block/route"
import * as publicOne from "@/app/api/public/trade-block/[code]/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ALICE = { id: "aaaaaaaa-0000-4000-8000-000000000001" }
const BOB = { id: "bbbbbbbb-0000-4000-8000-000000000002" }
const WA = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac" }
const WB = { signer: "0x00000000000000bb", source: "0x00000000000000bc" }

const wmc = (wallet: string, collection: string, id: string, player: string, fmv: number | null, conf: string | null) => ({
  collection_id: collection,
  wallet_address: wallet,
  moment_id: id,
  edition_key: "1:2",
  serial_number: Number(id),
  player_name: player,
  character_name: null,
  set_name: "Set",
  tier: "COMMON",
  series_number: 8,
  image_url: null,
  fmv_usd: fmv,
  fmv_confidence: conf,
})

const get = (path: string) => new NextRequest(`http://x${path}`)
const post = (body: unknown) => new NextRequest("http://x/api/trade-block", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function as<T>(who: { id: string } | null, f: () => Promise<T>): Promise<T> {
  session.user = who
  try {
    return await f()
  } finally {
    session.user = null
  }
}

async function prove(who: { id: string }, w: { signer: string; source: string }) {
  chain.proof.mockResolvedValueOnce({ ok: true, address: w.signer })
  chain.accounts.mockResolvedValueOnce([
    { address: w.signer, role: "flow_wallet", name: null, dapper: false, topshot_count: 0 },
    { address: w.source, role: "linked", name: "Dapper Wallet", dapper: true, topshot_count: 10 },
  ])
  const r = await as(who, () => signedIn.POST(post({ action: "wallet", proof: { x: 1 }, source: w.source })))
  expect(r.status).toBe(200)
}

async function postListing(body: Record<string, unknown>) {
  return as(ALICE, () => signedIn.POST(post({ action: "create", ...body })))
}

beforeEach(() => {
  mem.current = memorySupabase(
    {
      wallet_moments_cache: [
        wmc(WA.source, TS, "1", "Victor Wembanyama", 40, "HIGH"),
        wmc(WA.source, TS, "2", "Stephon Castle", 5, "LOW"),
        // the same moment id in another collection must never stand in for the Top Shot one
        wmc(WA.source, AD, "1", "Brock Purdy", 9, "MEDIUM"),
        wmc(WB.source, TS, "9", "Anthony Edwards", 30, "MEDIUM"),
        wmc(WB.source, AD, "7", "Josh Allen", 12, "HIGH"),
      ],
      profile_bio: [
        { user_id: ALICE.id, username: "webz_80" },
        { user_id: BOB.id, username: "ThunderHour" },
      ],
      editions: [{ id: "e0000000-0000-4000-8000-000000000001", external_id: "73:2619", collection_id: TS, player_name: "LeBron James", set_name: "Base", tier: "RARE" }],
    },
    { trade_block_listings: [["code"]], trade_block_proposals: [["code"]], trade_block_wallets: [["user_id", "source"]] },
    {
      trade_block_listings: { status: "open", open_to_offers: true, closed_reason: null, closed_at: null, note: null },
      trade_block_proposals: { status: "pending", note: null, room_code: null, decided_at: null },
      trade_rooms: { status: "open", version: 1, collection: "nba_top_shot", tx_id: null, landed: null, sealed_at: null, cancelled_by: null, cancel_reason: null },
      trade_room_sides: { signer: null, source: null, proven_at: null, accepted_version: null, notice_read_at: null },
    },
  )
  signedIn.__resetTradeBlockProofRateLimit()
  notices.sent.length = 0
})
afterEach(() => vi.clearAllMocks())

describe("posting a listing", () => {
  it("is refused before an account is proved", async () => {
    const r = await postListing({ offers: [{ collection_id: TS, moment_id: "1" }], open_to_offers: true })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { code: string }).code).toBe("no_wallet")
  })

  it("offers only what is in a proven account, and a foreign collection's same id does not count", async () => {
    await prove(ALICE, WA)
    const bad = await postListing({ offers: [{ collection_id: TS, moment_id: "9" }] })
    expect(bad.status).toBe(409)
    expect(((await bad.json()) as { code: string }).code).toBe("not_held")
    const ok = await postListing({
      offers: [
        { collection_id: TS, moment_id: "1" },
        { collection_id: AD, moment_id: "1" },
      ],
      wants: [
        { kind: "edition", collection_id: TS, edition_key: "73:2619" },
        { kind: "player", collection_id: AD, player_name: "Josh Allen" },
      ],
      note: "Looking for LeBron",
    })
    expect(ok.status).toBe(201)
    const { listing } = (await ok.json()) as { listing: { offers: Array<{ player_name: string; fmv_usd: number | null }>; wants: Array<{ player_name: string; set_name: string | null }> } }
    expect(listing.offers.map((o) => o.player_name)).toEqual(["Victor Wembanyama", "Brock Purdy"])
    // the edition want takes its labels from the catalog, not the client
    expect(listing.wants[0]).toMatchObject({ player_name: "LeBron James", set_name: "Base" })
  })

  it("refuses a note that carries cash or contact, with the reason", async () => {
    await prove(ALICE, WA)
    const r = await postListing({ offers: [{ collection_id: TS, moment_id: "1" }], note: "+$40 venmo" })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toMatch(/no cash/)
    expect(mem.current.tables.trade_block_listings ?? []).toHaveLength(0)
  })

  it("does not list the same asset on two open listings", async () => {
    await prove(ALICE, WA)
    expect((await postListing({ offers: [{ collection_id: TS, moment_id: "1" }] })).status).toBe(201)
    const again = await postListing({ offers: [{ collection_id: TS, moment_id: "1" }] })
    expect(again.status).toBe(409)
  })

  it("an unknown edition want is refused, never stored as typed", async () => {
    await prove(ALICE, WA)
    const r = await postListing({ offers: [{ collection_id: TS, moment_id: "1" }], wants: [{ kind: "edition", collection_id: TS, edition_key: "1:1" }] })
    expect(r.status).toBe(400)
  })
})

describe("public reads", () => {
  it("list and listing carry no wallet address; anon may read", async () => {
    await prove(ALICE, WA)
    const created = (await (await postListing({ offers: [{ collection_id: TS, moment_id: "1" }] })).json()) as { listing: { code: string } }
    const list = await as(null, () => publicList.GET(get("/api/public/trade-block")))
    expect(list.status).toBe(200)
    const text = await list.text()
    expect(text).toMatch(/webz_80/)
    expect(text).not.toMatch(/0x[0-9a-f]{16}/i)
    const one = await as(null, () => publicOne.GET(get(`/api/public/trade-block/${created.listing.code}`), { params: Promise.resolve({ code: created.listing.code }) }))
    const body = (await one.json()) as { listing: { offers: Array<{ in_index: boolean | null }> }; signed_in: boolean }
    expect(JSON.stringify(body)).not.toMatch(/0x[0-9a-f]{16}/i)
    expect(body.signed_in).toBe(false)
    expect(body.listing.offers[0].in_index).toBe(true)
  })

  it("a failed read is a 503, never an empty block", async () => {
    mem.current.failNext("select", "trade_block_listings")
    const r = await publicList.GET(get("/api/public/trade-block"))
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(await r.text()).not.toMatch(/"listings":\[\]/)
  })

  it("an unknown collection filter is refused, not answered with every listing", async () => {
    const r = await publicList.GET(get("/api/public/trade-block?collection=bogus"))
    expect(r.status).toBe(400)
  })

  it("filters by collection and player", async () => {
    await prove(ALICE, WA)
    await postListing({ offers: [{ collection_id: AD, moment_id: "1" }] })
    const ts = (await (await publicList.GET(get("/api/public/trade-block?collection=nba-top-shot"))).json()) as { listings: unknown[] }
    const ad = (await (await publicList.GET(get("/api/public/trade-block?collection=nfl-all-day&q=purdy"))).json()) as { listings: unknown[] }
    expect(ts.listings).toHaveLength(0)
    expect(ad.listings).toHaveLength(1)
  })
})

describe("proposals and the seam with the trade room", () => {
  async function listingByAlice(offers: Array<{ collection_id: string; moment_id: string }>) {
    await prove(ALICE, WA)
    const r = await postListing({ offers })
    return ((await r.json()) as { listing: { code: string } }).listing.code
  }

  it("an all-Top-Shot proposal, accepted, opens a room with both collectors in it", async () => {
    const code = await listingByAlice([{ collection_id: TS, moment_id: "1" }])
    await prove(BOB, WB)
    const p = await as(BOB, () => signedIn.POST(post({ action: "propose", code, give: [{ collection_id: TS, moment_id: "9" }], get: [{ collection_id: TS, moment_id: "1" }] })))
    expect(p.status).toBe(201)
    const proposal = ((await p.json()) as { proposal: { code: string; unsignable: string[] } }).proposal
    expect(proposal.unsignable).toEqual([])
    expect(notices.sent.at(-1)).toMatchObject({ to: ALICE.id, notice: "proposal" })

    // only the lister may answer
    expect((await as(BOB, () => signedIn.POST(post({ action: "decide", proposal: proposal.code, accept: true })))).status).toBe(403)

    const d = await as(ALICE, () => signedIn.POST(post({ action: "decide", proposal: proposal.code, accept: true })))
    expect(d.status).toBe(200)
    const out = (await d.json()) as { room_code: string | null }
    expect(out.room_code).toMatch(/^[a-z0-9]{10}$/)
    const room = mem.current.tables.trade_rooms.find((r) => r.code === out.room_code)!
    const sides = mem.current.tables.trade_room_sides.filter((s) => s.room_id === room.id)
    expect(sides.map((s) => [s.side, s.user_id]).sort()).toEqual([["a", ALICE.id], ["b", BOB.id]])
    expect(room.status).toBe("building")
    expect(notices.sent.at(-1)).toMatchObject({ to: BOB.id, notice: "accepted", room: out.room_code })
  })

  it("a proposal with any other collection, accepted, opens no room and says which", async () => {
    const code = await listingByAlice([{ collection_id: TS, moment_id: "1" }])
    await prove(BOB, WB)
    const p = await as(BOB, () => signedIn.POST(post({ action: "propose", code, give: [{ collection_id: AD, moment_id: "7" }], get: [{ collection_id: TS, moment_id: "1" }] })))
    const proposal = ((await p.json()) as { proposal: { code: string } }).proposal
    const d = await as(ALICE, () => signedIn.POST(post({ action: "decide", proposal: proposal.code, accept: true })))
    const out = (await d.json()) as { room_code: string | null; unsignable: string[] }
    expect(out.room_code).toBeNull()
    expect(out.unsignable).toEqual(["NFL All Day"])
    expect(mem.current.tables.trade_rooms ?? []).toHaveLength(0)
  })

  it("you cannot propose on your own listing, ask for what it does not offer, or give what you have not proved", async () => {
    const code = await listingByAlice([{ collection_id: TS, moment_id: "1" }])
    expect((await as(ALICE, () => signedIn.POST(post({ action: "propose", code, give: [{ collection_id: TS, moment_id: "2" }], get: [{ collection_id: TS, moment_id: "1" }] })))).status).toBe(409)
    const noWallet = await as(BOB, () => signedIn.POST(post({ action: "propose", code, give: [{ collection_id: TS, moment_id: "9" }], get: [{ collection_id: TS, moment_id: "1" }] })))
    expect(((await noWallet.json()) as { code: string }).code).toBe("no_wallet")
    await prove(BOB, WB)
    const notOffered = await as(BOB, () => signedIn.POST(post({ action: "propose", code, give: [{ collection_id: TS, moment_id: "9" }], get: [{ collection_id: TS, moment_id: "2" }] })))
    expect(((await notOffered.json()) as { code: string }).code).toBe("not_offered")
  })

  it("closing a listing declines its pending proposals; only the owner may close it", async () => {
    const code = await listingByAlice([{ collection_id: TS, moment_id: "1" }])
    await prove(BOB, WB)
    await as(BOB, () => signedIn.POST(post({ action: "propose", code, give: [{ collection_id: TS, moment_id: "9" }], get: [{ collection_id: TS, moment_id: "1" }] })))
    expect((await as(BOB, () => signedIn.POST(post({ action: "close", code })))).status).toBe(403)
    expect((await as(ALICE, () => signedIn.POST(post({ action: "close", code })))).status).toBe(200)
    expect(mem.current.tables.trade_block_proposals[0].status).toBe("declined")
    const list = (await (await publicList.GET(get("/api/public/trade-block"))).json()) as { listings: unknown[] }
    expect(list.listings).toHaveLength(0)
  })

  it("the signed-in routes answer 401 to anon", async () => {
    expect((await signedIn.GET(get("/api/trade-block"))).status).toBe(401)
    expect((await signedIn.POST(post({ action: "close", code: "abcdefghij" }))).status).toBe(401)
  })
})
