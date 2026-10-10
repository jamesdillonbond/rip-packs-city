import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/panini-set-progress — Panini Sets tab backend (2026-09-27).
 *
 * Stated as the ABSENCE of false claims: a failed read is not an empty tracker, a
 * malformed username is not "0 of 499 owned", a username RPC never saw is not
 * "owns nothing", and a malformed row is not silently dropped from the list.
 */

type Res = { data: unknown; error: unknown }
const state: { rpc: Res; products: Res; coverage: Res } = {
  rpc: { data: [], error: null },
  products: { data: [], error: null },
  coverage: { data: [], error: null },
}
// Args of the per-product SETS read only (panini_set_progress_all), with the product filter it applied.
const rpcArgs: unknown[] = []
const productArgs: unknown[] = []
const eqs: [string, unknown][] = []

vi.mock("@/lib/supabase", () => {
  const coverage: any = {
    select: () => coverage,
    limit: () => coverage,
    then: (resolve: any) => resolve(state.coverage),
  }
  return {
    supabaseAdmin: {
      from: () => coverage,
      rpc: (fn: string, args: unknown) => {
        if (fn === "panini_set_progress_products") {
          productArgs.push(args)
          return { then: (resolve: any) => resolve(state.products) }
        }
        rpcArgs.push(args)
        const q: any = {
          eq: (col: string, v: unknown) => {
            eqs.push([col, v])
            return q
          },
          then: (resolve: any) => resolve(state.rpc),
        }
        return q
      },
    },
  }
})

import { GET } from "@/app/api/panini-set-progress/route"
import { parsePaniniSetRow, parsePaniniProductRow } from "@/lib/panini/set-progress"

const req = (qs = "") => ({ nextUrl: new URL("https://t/api/panini-set-progress" + qs) }) as any

const ROW = {
  set_name: "Base Prizms Gold", editions_seen: 312, players_seen: 312, min_mint_cap: 10, max_mint_cap: 10,
  still_in_packs: 331, owned: 0, missing: 312, missing_asked: 300, missing_unasked: 12,
  cost_usd: "412000.00", max_missing_ask_usd: "100000", owner_last_seen_at: null,
}

const WC = { product_set_id: 2332, product_name: "2026 Panini NFT Prizm World Cup Soccer", sport: "Soccer", sets: 1, editions_seen: 312, owned: 0, owner_last_seen_at: null }
const NFL = { product_set_id: 1940, product_name: "2023 Panini NFT Prizm Football", sport: "Football", sets: 1, editions_seen: 90, owned: 0, owner_last_seen_at: null }

beforeEach(() => {
  rpcArgs.length = 0
  productArgs.length = 0
  eqs.length = 0
  state.rpc = { data: [ROW], error: null }
  state.products = { data: [WC, NFL], error: null }
  state.coverage = { data: [{ total_editions: 5101, pct_trustworthy: 35 }], error: null }
})

async function body(qs = "") {
  const res = await GET(req(qs))
  return { status: res.status, json: await res.json() }
}

describe("GET /api/panini-set-progress", () => {
  it("serves every set with the cost split into priced + unpriced and the largest ask", async () => {
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(rpcArgs[0]).toEqual({ p_username: null })
    // No product asked for and no username → the World Cup product, filtered in the read.
    expect(eqs).toEqual([["product_set_id", 2332]])
    expect(json.product).toMatchObject({ setId: 2332, sport: "Soccer" })
    expect(json.products.map((p: any) => p.setId)).toEqual([2332, 1940])
    expect(json.username).toBeNull()
    expect(json.userSeen).toBeNull()
    expect(json.sets[0]).toMatchObject({ setName: "Base Prizms Gold", missingAsked: 300, missingUnasked: 12, costUsd: 412000, maxMissingAskUsd: 100000 })
  })

  it("folds the username before the read (owner is matched on lower())", async () => {
    state.rpc = { data: [{ ...ROW, owned: 5, missing: 307, owner_last_seen_at: "2026-09-27 14:24:49+00" }], error: null }
    state.products = { data: [WC, { ...NFL, owned: 5, owner_last_seen_at: "2026-09-27 14:24:49+00" }], error: null }
    const { json } = await body("?username=@AdlCards")
    expect(rpcArgs[0]).toEqual({ p_username: "adlcards" })
    expect(productArgs[0]).toEqual({ p_username: "adlcards" })
    // With a username, the default product is the one RPC has seen them hold most of.
    expect(eqs).toEqual([["product_set_id", 1940]])
    expect(json.userSeen).toBe(true)
    expect(json.userLastSeenAt).toBe("2026-09-27 14:24:49+00")
  })

  it("a username RPC has never seen is userSeen:false — not 'owns nothing'", async () => {
    const { json } = await body("?username=nobody_here")
    expect(json.userSeen).toBe(false)
    expect(json.userLastSeenAt).toBeNull()
  })

  it("a malformed username is a 400 for the username — no read, no all-zero tracker", async () => {
    const { status, json } = await body("?username=" + encodeURIComponent("0x1234567890abcdef1234"))
    expect(status).toBe(400)
    expect(json.sets).toBeUndefined()
    expect(rpcArgs).toHaveLength(0)
  })

  it("a failed read is a 503, never an empty set list", async () => {
    state.rpc = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
    const { status, json } = await body()
    expect(status).toBe(503)
    expect(json.sets).toBeUndefined()
    expect(JSON.stringify(json)).not.toContain("canceling statement")
  })

  it("a malformed row fails the read rather than vanishing from the list", async () => {
    state.rpc = { data: [ROW, { ...ROW, set_name: "Base Prizms Blue", missing: null }], error: null }
    const { status, json } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(json.sets).toBeUndefined()
  })

  it("serves the product asked for, and only that product's sets", async () => {
    const { status, json } = await body("?product=1940")
    expect(status).toBe(200)
    expect(eqs).toEqual([["product_set_id", 1940]])
    expect(json.product.setId).toBe(1940)
  })

  it("an unknown product is a 400 — never another product's sets in its place", async () => {
    const { status, json } = await body("?product=9999")
    expect(status).toBe(400)
    expect(json.sets).toBeUndefined()
    expect(rpcArgs).toHaveLength(0)
  })

  it("a malformed product id is a 400 with no read", async () => {
    const { status } = await body("?product=abc")
    expect(status).toBe(400)
    expect(productArgs).toHaveLength(0)
  })

  it("a failed product-summary read is a 503, never an empty tracker", async () => {
    state.products = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
    const { status, json } = await body()
    expect(status).toBe(503)
    expect(json.sets).toBeUndefined()
  })

  it("a list at the 1,000-row clamp may be partial, so it fails rather than serving as complete", async () => {
    state.rpc = { data: Array.from({ length: 1000 }, (_, i) => ({ ...ROW, set_name: `S${i}` })), error: null }
    state.products = { data: [{ ...WC, sets: 1000 }], error: null }
    const { status, json } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(json.sets).toBeUndefined()
  })

  it("sets that disagree with the product summary's count fail the read", async () => {
    state.products = { data: [{ ...WC, sets: 2 }], error: null }
    const { status, json } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(json.sets).toBeUndefined()
  })

  it("a failed coverage read drops the figures and says so; the sets still serve", async () => {
    state.coverage = { data: null, error: { message: "boom" } }
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(json.coverage).toBeNull()
    expect(json.coverage_error).toBe(true)
    expect(json.sets).toHaveLength(1)
  })
})

describe("parsePaniniSetRow", () => {
  it("a null count is a malformed row, never a zero", () => {
    for (const k of ["owned", "missing", "missing_asked", "missing_unasked"]) {
      expect(parsePaniniSetRow({ ...ROW, [k]: null }), k).toBeNull()
    }
  })
  it("no priced edition leaves the cost null, not $0", () => {
    const r = parsePaniniSetRow({ ...ROW, missing_asked: 0, cost_usd: null, max_missing_ask_usd: null })
    expect(r?.costUsd).toBeNull()
    expect(r?.maxMissingAskUsd).toBeNull()
  })
  it("drops a row with no set name or no seen editions", () => {
    expect(parsePaniniSetRow({ ...ROW, set_name: "" })).toBeNull()
    expect(parsePaniniSetRow({ ...ROW, editions_seen: 0 })).toBeNull()
    expect(parsePaniniSetRow(null)).toBeNull()
  })
})

describe("parsePaniniProductRow", () => {
  it("a null count is a malformed row, never a zero", () => {
    for (const k of ["sets", "editions_seen", "owned"]) {
      expect(parsePaniniProductRow({ ...WC, [k]: null }), k).toBeNull()
    }
  })
  it("an unnamed product keeps name null — no invented name", () => {
    expect(parsePaniniProductRow({ ...NFL, product_name: null })?.name).toBeNull()
  })
})
