import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { memorySupabase, type MemoryDb } from "./helpers/memory-supabase"

// Trade Block v2 (2026-11-02): the matcher, the "a listing fits" email, and the room's
// guide from the accepted proposal.
//   · a match is within ONE collection, by catalog key or an accent-blind name;
//   · only PROVEN accounts are matched, never the caller's own listing;
//   · a failed read is a 503 from the route, never "no matches";
//   · at most one match email per collector per Pacific day, claimed before the send;
//   · the room opened from a proposal shows what each side agreed, lister = side A.

const mem = vi.hoisted(() => ({ current: null as unknown as MemoryDb }))
const session = vi.hoisted(() => ({ user: null as { id: string } | null }))
const chain = vi.hoisted(() => ({ accounts: vi.fn(), proof: vi.fn() }))
const notices = vi.hoisted(() => ({ sent: [] as Array<{ to: string; actor: string; notice: string; listing?: string | null; room?: string | null }> }))

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
vi.mock("@/lib/trade-block/notify", async (orig) => ({
  ...(await orig<typeof import("@/lib/trade-block/notify")>()),
  notifyBlock: async (_db: unknown, to: string, actor: string, notice: string, opts: { listingCode?: string | null; roomCode?: string | null }) => {
    notices.sent.push({ to, actor, notice, listing: opts?.listingCode, room: opts?.roomCode })
    return { status: "sent", notice }
  },
}))
vi.mock("@/lib/trade-room/notify", () => ({ notifyOtherSide: async () => ({ status: "sent" }) }))

import * as block from "@/app/api/trade-block/route"
import * as room from "@/app/api/trade-room/[code]/route"
import { assembleMatches, foldName, holdingsForWants, MAX_PLAYER_LOOKUPS, satisfies, wantKeys } from "@/lib/trade-block/match"
import { notifyMatchesForListing, pacificDay } from "@/lib/trade-block/match-notify"
import type { ItemRow, LoadedListing } from "@/lib/trade-block/store"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ALICE = { id: "aaaaaaaa-0000-4000-8000-000000000001" }
const BOB = { id: "bbbbbbbb-0000-4000-8000-000000000002" }
const CARL = { id: "cccccccc-0000-4000-8000-000000000003" }
const WA = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac" }
const WB = { signer: "0x00000000000000bb", source: "0x00000000000000bc" }
const WC = { signer: "0x00000000000000cb", source: "0x00000000000000cc" }

const wmc = (wallet: string, collection: string, id: string, player: string, edition = "1:2") => ({
  collection_id: collection,
  wallet_address: wallet,
  moment_id: id,
  edition_key: edition,
  serial_number: Number(id),
  player_name: player,
  character_name: null,
  set_name: "Set",
  tier: "COMMON",
  series_number: 8,
  image_url: null,
  fmv_usd: 10,
  fmv_confidence: "HIGH",
})

const get = (path: string) => new NextRequest(`http://x${path}`)
const post = (body: unknown, path = "/api/trade-block") => new NextRequest(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

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
  chain.accounts.mockResolvedValueOnce([{ address: w.source, role: "flow_wallet", name: null, dapper: true, topshot_count: 5 }])
  const r = await as(who, () => block.POST(post({ action: "wallet", proof: { x: 1 }, source: w.source })))
  expect(r.status).toBe(200)
}

beforeEach(() => {
  mem.current = memorySupabase(
    {
      wallet_moments_cache: [
        wmc(WA.source, TS, "1", "Victor Wembanyama", "73:1"),
        wmc(WB.source, TS, "9", "Luka Dončić", "73:9"),
        wmc(WB.source, AD, "7", "Josh Allen", "4790"),
        // same name in another collection must not satisfy a Top Shot want
        wmc(WC.source, AD, "3", "Luka Dončić", "999"),
      ],
      profile_bio: [
        { user_id: ALICE.id, username: "webz_80" },
        { user_id: BOB.id, username: "ThunderHour" },
        { user_id: CARL.id, username: "sdb" },
      ],
      editions: [{ id: "e1", external_id: "4790", collection_id: AD, player_name: "Josh Allen", set_name: "Base", tier: "RARE" }],
    },
    { trade_block_listings: [["code"]], trade_block_proposals: [["code"]], trade_block_wallets: [["user_id", "source"]], trade_block_match_notices: [["user_id", "day"]] },
    {
      trade_block_listings: { status: "open", open_to_offers: true, closed_reason: null, closed_at: null, note: null },
      trade_block_proposals: { status: "pending", note: null, room_code: null, decided_at: null },
      trade_rooms: { status: "open", version: 1, collection: "nba_top_shot", tx_id: null, landed: null, sealed_at: null, cancelled_by: null, cancel_reason: null },
      trade_room_sides: { signer: null, source: null, proven_at: null, accepted_version: null, notice_read_at: null },
    },
  )
  block.__resetTradeBlockProofRateLimit()
  notices.sent.length = 0
})
afterEach(() => vi.clearAllMocks())

describe("matching rules (pure)", () => {
  const want = (p: Partial<ItemRow>): ItemRow =>
    ({ listing_id: "L", role: "want", pos: 0, collection_id: TS, kind: "player", moment_id: null, source: null, edition_key: null, player_name: null, set_name: null, tier: null, series_number: null, serial_number: null, image_url: null, fmv_usd: null, ...p }) as ItemRow

  it("a player want is accent- and case-blind, and never crosses collections", () => {
    const [w] = wantKeys([want({ player_name: "luka DONCIC" })])
    expect(foldName("Luka Dončić")).toBe("luka doncic")
    expect(satisfies(w, { collection_id: TS, edition_key: null, player_name: "Luka Dončić" })).toBe(true)
    expect(satisfies(w, { collection_id: AD, edition_key: null, player_name: "Luka Dončić" })).toBe(false)
  })

  it("an edition want matches its catalog key only", () => {
    const [w] = wantKeys([want({ kind: "edition", edition_key: "73:9" })])
    expect(satisfies(w, { collection_id: TS, edition_key: "73:9", player_name: "x" })).toBe(true)
    expect(satisfies(w, { collection_id: TS, edition_key: "73:10", player_name: "x" })).toBe(false)
  })

  it("two-way matches rank first", () => {
    const listing = (code: string, items: Partial<ItemRow>[]): LoadedListing =>
      ({ listing: { id: code, code, user_id: "x", created_at: "2026-11-02T00:00:00Z" }, items: items.map((i) => want(i)) }) as unknown as LoadedListing
    const holding = { collection_id: TS, moment_id: "1", source: "s", edition_key: "73:1", player_name: "Victor Wembanyama", set_name: null, tier: null, series_number: null, serial_number: null, image_url: null, fmv_usd: null, fmv_from_asks: false, locked: false }
    const one = listing("one", [{ player_name: "Victor Wembanyama" }])
    const two = listing("two", [{ player_name: "Victor Wembanyama" }, { role: "offer", kind: "moment", moment_id: "5", player_name: "Josh Allen", collection_id: AD, edition_key: "4790" }])
    const out = assembleMatches([one, two], [{ collection_id: AD, kind: "edition", key: "4790" }], [holding])
    expect(out.map((m) => [m.listing.listing.code, m.two_way])).toEqual([["two", true], ["one", false]])
  })
})

describe("GET /api/trade-block?matches=1", () => {
  it("finds listings that want what you hold and that offer what you want — never your own", async () => {
    await prove(ALICE, WA)
    await prove(BOB, WB)
    // Alice offers her Wemby, wants any Luka Dončić (typed without the accent) and the Josh Allen edition
    const a = await as(ALICE, () =>
      block.POST(post({ action: "create", offers: [{ collection_id: TS, moment_id: "1" }], wants: [{ kind: "player", collection_id: TS, player_name: "luka doncic" }, { kind: "edition", collection_id: AD, edition_key: "4790" }] })),
    )
    expect(a.status).toBe(201)
    // Bob offers his Josh Allen and wants any Wembanyama
    const b = await as(BOB, () => block.POST(post({ action: "create", offers: [{ collection_id: AD, moment_id: "7" }], wants: [{ kind: "player", collection_id: TS, player_name: "Victor Wembanyama" }] })))
    expect(b.status).toBe(201)

    const r = await as(BOB, () => block.GET(get("/api/trade-block?matches=1")))
    expect(r.status).toBe(200)
    const body = (await r.json()) as { proven: boolean; my_wants: number; matches: Array<{ listing: { username: string }; you_hold: Array<{ player_name: string }>; they_offer: Array<{ player_name: string }>; two_way: boolean }> }
    expect(body.proven).toBe(true)
    expect(body.matches).toHaveLength(1)
    const m = body.matches[0]
    expect(m.listing.username).toBe("webz_80")
    expect(m.you_hold.map((h) => h.player_name).sort()).toEqual(["Josh Allen", "Luka Dončić"])
    expect(m.they_offer.map((h) => h.player_name)).toEqual(["Victor Wembanyama"])
    expect(m.two_way).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/0x[0-9a-f]{16}/)
  })

  it("a failed read is a 503, never 'no matches'", async () => {
    await prove(BOB, WB)
    mem.current.failNext("select", "trade_block_listings")
    const r = await as(BOB, () => block.GET(get("/api/trade-block?matches=1")))
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(await r.text()).not.toMatch(/"matches"/)
  })
})

describe("holdingsForWants reports its own truncation (2026-11-07 review)", () => {
  it("player wants beyond the lookup cap mark the read truncated — never a silent 'complete'", async () => {
    const wants = Array.from({ length: MAX_PLAYER_LOOKUPS + 1 }, (_, i) => ({ kind: "player" as const, collection_id: TS, key: `player number${i}` }))
    const meta = { truncated: false }
    await holdingsForWants(mem.current.db, [WA.source], wants as never, meta)
    expect(meta.truncated).toBe(true)
    // control: at the cap, nothing is dropped
    const ok = { truncated: false }
    await holdingsForWants(mem.current.db, [WA.source], wants.slice(0, MAX_PLAYER_LOOKUPS) as never, ok)
    expect(ok.truncated).toBe(false)
  })
})

describe("match emails", () => {
  it("a new listing mails proven holders once a Pacific day, and never the poster or a non-holder", async () => {
    await prove(ALICE, WA)
    await prove(BOB, WB)
    await prove(CARL, WC)
    const posted = async () => {
      const r = await as(ALICE, () => block.POST(post({ action: "create", offers: [{ collection_id: TS, moment_id: "1" }], wants: [{ kind: "player", collection_id: TS, player_name: "Luka Doncic" }] })))
      expect(r.status).toBe(201)
      await new Promise((res) => setTimeout(res, 0))
      await new Promise((res) => setTimeout(res, 0))
    }
    await posted()
    // Bob holds a Top Shot Luka; Carl's Luka is All Day, so he is not mailed
    expect(notices.sent.filter((n) => n.notice === "match").map((n) => n.to)).toEqual([BOB.id])
    expect(notices.sent[0].listing).toMatch(/^[a-z0-9]{10}$/)
    // a second listing the same day: the claim exists, nobody is mailed again
    mem.current.tables.trade_block_items = []
    mem.current.tables.trade_block_listings = []
    await posted()
    expect(notices.sent.filter((n) => n.notice === "match")).toHaveLength(1)
  })

  it("the summary reports skips and failures instead of swallowing them", async () => {
    await prove(BOB, WB)
    const loaded = {
      listing: { id: "L1", code: "abcdefghij", user_id: ALICE.id },
      items: [{ role: "want", kind: "player", collection_id: TS, player_name: "Luka Doncic", edition_key: null }],
    } as unknown as LoadedListing
    const notify = vi.fn(async () => ({ status: "failed" as const, error: "smtp" }))
    const now = Date.parse("2026-11-02T18:00:00Z")
    const s1 = await notifyMatchesForListing(mem.current.db, loaded, { notify, log: () => undefined, now })
    expect(s1).toMatchObject({ recipients: 1, sent: 0, failed: 1 })
    const s2 = await notifyMatchesForListing(mem.current.db, loaded, { notify, log: () => undefined, now })
    expect(s2).toMatchObject({ recipients: 1, skipped_today: 1 })
    mem.current.failNext("select", "trade_block_wallets")
    const s3 = await notifyMatchesForListing(mem.current.db, loaded, { notify, log: () => undefined, now })
    expect(s3.error).toMatch(/trade_block_wallets/)
  })

  it("the day is the Pacific day", () => {
    // 2026-11-03 05:00 UTC is still 2026-11-02 in Los Angeles
    expect(pacificDay(Date.parse("2026-11-03T05:00:00Z"))).toBe("2026-11-02")
  })
})

describe("the room opened from a proposal shows what was agreed", () => {
  it("lister is side A and gives the listed asset; proposer is side B", async () => {
    await prove(ALICE, WA)
    await prove(BOB, WB)
    const created = (await (await as(ALICE, () => block.POST(post({ action: "create", offers: [{ collection_id: TS, moment_id: "1" }] })))).json()) as { listing: { code: string } }
    const p = (await (await as(BOB, () => block.POST(post({ action: "propose", code: created.listing.code, give: [{ collection_id: TS, moment_id: "9" }], get: [{ collection_id: TS, moment_id: "1" }] })))).json()) as {
      proposal: { code: string }
    }
    const d = (await (await as(ALICE, () => block.POST(post({ action: "decide", proposal: p.proposal.code, accept: true })))).json()) as { room_code: string }
    const r = await as(BOB, () => room.GET(get(`/api/trade-room/${d.room_code}`), { params: Promise.resolve({ code: d.room_code }) }))
    expect(r.status).toBe(200)
    const body = (await r.json()) as { room: { from_block: { listing_code: string; a_gives: Array<{ player_name: string }>; b_gives: Array<{ player_name: string }> } } }
    expect(body.room.from_block.listing_code).toBe(created.listing.code)
    expect(body.room.from_block.a_gives.map((i) => i.player_name)).toEqual(["Victor Wembanyama"])
    expect(body.room.from_block.b_gives.map((i) => i.player_name)).toEqual(["Luka Dončić"])
  })

  it("a room not from the block has no guide, and a failed guide read does not fail the room", async () => {
    await prove(ALICE, WA)
    await prove(BOB, WB)
    const created = (await (await as(ALICE, () => block.POST(post({ action: "create", offers: [{ collection_id: TS, moment_id: "1" }] })))).json()) as { listing: { code: string } }
    const p = (await (await as(BOB, () => block.POST(post({ action: "propose", code: created.listing.code, give: [{ collection_id: TS, moment_id: "9" }], get: [{ collection_id: TS, moment_id: "1" }] })))).json()) as { proposal: { code: string } }
    const d = (await (await as(ALICE, () => block.POST(post({ action: "decide", proposal: p.proposal.code, accept: true })))).json()) as { room_code: string }
    mem.current.failNext("select", "trade_block_proposals")
    const r = await as(BOB, () => room.GET(get(`/api/trade-room/${d.room_code}`), { params: Promise.resolve({ code: d.room_code }) }))
    expect(r.status).toBe(200)
    expect(((await r.json()) as { room: { from_block: unknown } }).room.from_block).toBeNull()
  })
})
