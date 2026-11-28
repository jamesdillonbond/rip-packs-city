import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/public/insights/whales + lib/whale-watch-board.ts (2026-11-27).
//
// The board is ONE precomputed row. Pinned here:
//   · the route returns the shaped board on the happy path;
//   · a failed read AND a missing snapshot are a 500, never an empty board —
//     "no whales" would be a market claim made out of a broken writer;
//   · a whale with no username shows a SHORTENED wallet marked "…", and a Solana
//     key keeps its case (no fold, no 0x prefix).

const state: { row: any; error: { message: string } | null } = { row: null, error: null }

vi.mock("@/lib/supabase", () => {
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: state.row, error: state.error }),
        }),
      }),
    }),
  }
  return { supabaseAdmin: db, supabase: db }
})

import { GET } from "@/app/api/public/insights/whales/route"
import { shapeWhaleBoard, whaleName, whaleHref, whaleItemHref, fetchWhaleWatchBoard } from "@/lib/whale-watch-board"
import { supabaseAdmin } from "@/lib/supabase"

const req = (u = "https://t/api/public/insights/whales") => ({ url: u, nextUrl: new URL(u) }) as any

const RAW = {
  tracked_wallets: 573,
  active_7d: 185,
  spend_7d_usd: 132742.37,
  new_tracked_7d: 10,
  leaders: {
    "7d": [{ rank: 1, username: "cmnkb8", chain: "flow", wallet: null, buys: 34, pack_buys: 3, spent_usd: 10427.48, biggest_usd: 2199, collections: ["nba_top_shot"], last_at: "2026-11-27T15:50:00Z" }],
    "30d": [],
  },
  moves: [{ at: "2026-11-27T15:50:00Z", collection: "nba_top_shot", kind: "pack", item: "Rookie Debut Case", price_usd: 2020, username: "cmnkb8", chain: "flow", wallet: null, edition_id: null }],
  biggest_30d: [],
}

beforeEach(() => {
  state.error = null
  state.row = { board: RAW, computed_at: "2026-11-27T23:48:23Z" }
})

describe("GET /api/public/insights/whales", () => {
  it("returns the shaped board with its computed_at", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.computed_at).toBe("2026-11-27T23:48:23Z")
    expect(body.tracked_wallets).toBe(573)
    expect(body.leaders["7d"][0].username).toBe("cmnkb8")
    expect(body.leaders["7d"][0].spent_usd).toBe(10427.48)
    expect(body.moves[0].item).toBe("Rookie Debut Case")
  })

  it("fails (5xx) on a failed read and does not leak the driver text", async () => {
    // A statement timeout is a transient 503 by design (statusForSafeError).
    state.error = { message: "canceling statement due to statement timeout" }
    const res = await GET(req())
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.error).not.toContain("canceling statement")
    expect(body.leaders).toBeUndefined()
  })

  it("500s when no snapshot has been written — an absent board is not an empty market", async () => {
    state.row = null
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).tracked_wallets).toBeUndefined()
  })
})

describe("lib/whale-watch-board", () => {
  it("fetchWhaleWatchBoard throws on a missing row (control for the 500 above)", async () => {
    state.row = null
    await expect(fetchWhaleWatchBoard(supabaseAdmin)).rejects.toThrow(/no snapshot/)
  })

  it("shapeWhaleBoard tolerates a malformed board without inventing rows", () => {
    const b = shapeWhaleBoard({ leaders: { "7d": "nope" } }, null)
    expect(b.leaders["7d"]).toEqual([])
    expect(b.leaders["30d"]).toEqual([])
    expect(b.moves).toEqual([])
    expect(b.computed_at).toBeNull()
  })

  it("an older snapshot without by_collection / key / top_collection shapes to empty and null", () => {
    const b = shapeWhaleBoard(RAW, null)
    expect(b.by_collection).toEqual({})
    expect(b.leaders["7d"][0].key).toBeNull()
    expect(b.leaders["7d"][0].top_collection).toBeNull()
  })

  it("by_collection is shaped per collection and window", () => {
    const b = shapeWhaleBoard({ ...RAW, by_collection: { nba_top_shot: { "7d": RAW.leaders["7d"], "30d": "bad" } } }, null)
    expect(b.by_collection.nba_top_shot["7d"][0].username).toBe("cmnkb8")
    expect(b.by_collection.nba_top_shot["30d"]).toEqual([])
  })

  it("whaleHref routes Panini to ?username= and everything else to ?wallet=, keeping a Solana key's case", () => {
    expect(whaleHref("panini_blockchain", "spinotron")).toBe("/panini-blockchain/collection?username=spinotron")
    expect(whaleHref("nba_top_shot", "0x8e655887a360cc3f")).toBe("/nba-top-shot/collection?wallet=0x8e655887a360cc3f")
    expect(whaleHref("candy_mlb", "BxtiN3EJMjQzAbCdEfGh9")).toBe("/candy-mlb/collection?wallet=BxtiN3EJMjQzAbCdEfGh9")
    expect(whaleHref("ufc_strike", "0x1")).toBe("/ufc/collection?wallet=0x1")
    expect(whaleHref(null, "x")).toBeNull()
    expect(whaleHref("nba_top_shot", null)).toBeNull()
    expect(whaleHref("not_a_collection", "x")).toBeNull()
  })

  it("whaleItemHref links editions, Pinnacle pins and pack detail pages; no key → no link", () => {
    expect(whaleItemHref({ collection: "nba_top_shot", kind: "item", link_key: "160:5584" })).toBe("/nba-top-shot/edition/160%3A5584")
    expect(whaleItemHref({ collection: "disney_pinnacle", kind: "item", link_key: "OEV2-FROZ-OLAF-S5" })).toBe("/pinnacle/moment/OEV2-FROZ-OLAF-S5")
    expect(whaleItemHref({ collection: "panini_blockchain", kind: "item", link_key: "packcard-1605_293026_7958740_56" })).toBe("/panini-blockchain/edition/packcard-1605_293026_7958740_56")
    // A pack opens its detail page, never the simulator (Trevor's rule, 2026-11-12).
    expect(whaleItemHref({ collection: "nba_top_shot", kind: "pack", link_key: "1820" })).toBe("/nba-top-shot/pack/dist/1820")
    expect(whaleItemHref({ collection: "candy_mlb", kind: "pack", link_key: null })).toBeNull()
    expect(whaleItemHref({ collection: "nope", kind: "item", link_key: "x" })).toBeNull()
  })

  it("whaleName prefers the username", () => {
    expect(whaleName({ username: "spinotron", wallet: null })).toBe("spinotron")
  })

  it("whaleName shortens a Flow address and marks it with an ellipsis", () => {
    expect(whaleName({ username: null, wallet: "0x7e1a7dbe10882e17" })).toBe("0x7e1a…2e17")
  })

  it("whaleName keeps a Solana key's case and adds no 0x", () => {
    const n = whaleName({ username: null, wallet: "BxtiN3EJMjQzAbCdEfGh9" })
    expect(n).toBe("Bxti…fGh9")
    expect(n.startsWith("0x")).toBe(false)
    expect(n).toContain("Bxti")
  })
})
