// __tests__/api-ufc-aptos-holdings.test.ts
//
// GET /api/ufc/aptos-holdings — the UFC Strike moments a Flow collector holds ON APTOS.
// The contract is three states, never two (CLAUDE.md "Honesty"):
//   failed read → 5xx (never an empty list, never $0)
//   no link / no rows → { linked: false } (the binder renders no section)
//   rows → priced at current FMV; an unpriced moment is counted, never valued at 0.

import { beforeEach, describe, expect, it, vi } from "vitest"

const db = {
  holdings: [] as Array<{ token_data_id: string; edition_id: string | null; serial_number: number | null }>,
  holdingsError: null as unknown,
  editions: [] as Array<Record<string, unknown>>,
  fmv: [] as Array<{ edition_id: string; fmv_usd: number | null }>,
  fmvError: null as unknown,
  colls: [] as Array<{ edition_id: string; aptos_collection_id: string | null }>,
  collsError: null as unknown,
  rpcCalls: [] as Array<{ name: string; args: unknown; range?: [number, number] }>,
}

function thenable<T>(resolveWith: () => T, extra: Record<string, unknown> = {}) {
  const b: Record<string, unknown> = { ...extra }
  for (const m of ["select", "order", "in", "eq", "range"]) b[m] = () => b
  b.then = (ok: (v: T) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolveWith()).then(ok, bad)
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (name: string, args: unknown) => {
      const call: { name: string; args: unknown; range?: [number, number] } = { name, args }
      db.rpcCalls.push(call)
      if (name === "get_ufc_aptos_holdings_for_flow") {
        let lo = 0, hi = 999
        const b = thenable(() =>
          db.holdingsError ? { data: null, error: db.holdingsError } : { data: db.holdings.slice(lo, hi + 1), error: null },
        )
        b.range = (a: number, z: number) => { lo = a; hi = z; call.range = [a, z]; return b }
        return b
      }
      if (name === "get_editions_latest_fmv_wide") {
        return thenable(() => (db.fmvError ? { data: null, error: db.fmvError } : { data: db.fmv, error: null }))
      }
      throw new Error("unexpected rpc " + name)
    },
    from: (table: string) => {
      if (table === "ufc_aptos_collections") {
        return thenable(() => (db.collsError ? { data: null, error: db.collsError } : { data: db.colls, error: null }))
      }
      if (table !== "editions") throw new Error("unexpected table " + table)
      return thenable(() => ({ data: db.editions, error: null }))
    },
  },
}))

const { GET } = await import("@/app/api/ufc/aptos-holdings/route")
const req = (u: string) => ({ nextUrl: new URL(u) }) as never
const WALLET = "0x8c84d174d73e2d4c"

beforeEach(() => {
  db.holdings = []
  db.holdingsError = null
  db.editions = []
  db.fmv = []
  db.fmvError = null
  db.colls = []
  db.collsError = null
  db.rpcCalls = []
})

describe("GET /api/ufc/aptos-holdings", () => {
  it("400s on a missing or non-Flow wallet", async () => {
    expect((await GET(req("https://t/api/ufc/aptos-holdings"))).status).toBe(400)
    expect((await GET(req("https://t/api/ufc/aptos-holdings?wallet=0x10a12f7e"))).status).toBe(400)
  })

  it("a wallet with no link (or no Aptos rows) is { linked: false } — no section, no $0", async () => {
    const res = await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ linked: false })
    expect(body).not.toHaveProperty("total_fmv")
  })

  it("a failed holdings read is an error, never an empty list", async () => {
    db.holdingsError = { message: "canceling statement due to statement timeout", code: "57014" }
    const res = await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body).not.toHaveProperty("linked")
    expect(body).not.toHaveProperty("moments")
  })

  it("a failed FMV read is an error, never moments valued at 0", async () => {
    db.holdings = [{ token_data_id: "0xa", edition_id: "e1", serial_number: 17 }]
    db.fmvError = { message: "boom" }
    const res = await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("prices held moments at current FMV; an unpriced one is counted, not valued at 0", async () => {
    db.holdings = [
      { token_data_id: "0xa", edition_id: "e1", serial_number: 17 },
      { token_data_id: "0xb", edition_id: "e2", serial_number: 733 },
      { token_data_id: "0xc", edition_id: "e3", serial_number: 5 },
    ]
    db.editions = [
      { id: "e1", name: "Paddy Pimblett — Fight Night", player_name: "Paddy Pimblett", set_name: "Fight Night", tier: "COMMON", circulation_count: 4000, thumbnail_url: null },
      { id: "e2", name: "Geoff Neal — FN Aug 06 2022", player_name: "Geoff Neal", set_name: "FN Aug 06 2022", tier: "COMMON", circulation_count: 1000, thumbnail_url: null },
      { id: "e3", name: "Unpriced — Set", player_name: "Unpriced", set_name: "Set", tier: "RARE", circulation_count: 99, thumbnail_url: null },
    ]
    db.fmv = [
      { edition_id: "e1", fmv_usd: 1.25 },
      { edition_id: "e2", fmv_usd: 3 },
      { edition_id: "e3", fmv_usd: null },
    ]
    const body = await (await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))).json()
    expect(body.linked).toBe(true)
    expect(body.count).toBe(3)
    expect(body.priced).toBe(2)
    expect(body.unpriced).toBe(1)
    expect(body.total_fmv).toBe(4.25)
    const unpriced = body.moments.find((m: { token_data_id: string }) => m.token_data_id === "0xc")
    expect(unpriced.fmv_usd).toBeNull()
    // Link confidence and the Aptos address stay internal.
    expect(JSON.stringify(body)).not.toMatch(/confidence|aptos_address/)
  })

  it("no priced moment → total_fmv null (unknown), not 0", async () => {
    db.holdings = [{ token_data_id: "0xa", edition_id: "e1", serial_number: 1 }]
    db.editions = [{ id: "e1", name: "X", player_name: "X", set_name: "S", tier: null, circulation_count: null, thumbnail_url: null }]
    db.fmv = []
    const body = await (await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))).json()
    expect(body.total_fmv).toBeNull()
  })

  // 2026-11-26: the binder renders Aptos Moments as table rows linking to their edition page and Rarible.
  it("returns each Moment's edition key and Aptos collection (for the edition and Rarible links)", async () => {
    db.holdings = [{ token_data_id: "0xa", edition_id: "e1", serial_number: 1 }]
    db.editions = [{ id: "e1", external_id: "733", name: "X", player_name: "X", set_name: "S", tier: null, circulation_count: null, thumbnail_url: null }]
    db.colls = [{ edition_id: "e1", aptos_collection_id: "0xabc" }]
    const body = await (await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))).json()
    expect(body.moments[0].edition_key).toBe("733")
    expect(body.moments[0].aptos_collection_id).toBe("0xabc")
  })

  it("a failed Aptos-collection read drops the link only — the Moment and its value stay", async () => {
    db.holdings = [{ token_data_id: "0xa", edition_id: "e1", serial_number: 1 }]
    db.editions = [{ id: "e1", external_id: "733", name: "X", player_name: "X", set_name: "S", tier: null, circulation_count: null, thumbnail_url: null }]
    db.fmv = [{ edition_id: "e1", fmv_usd: 2 }]
    db.collsError = { message: "boom" }
    const res = await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.total_fmv).toBe(2)
    expect(body.moments[0].aptos_collection_id).toBeNull()
  })

  // 2026-11-26: an Aptos account is read LIVE from the Aptos indexer (Aptos-native / unlinked collectors).
  describe("?aptos= — an Aptos account read live", () => {
    const APT = "0x" + "ab".repeat(32)
    const page = (rows: unknown[]) => ({ ok: true, json: async () => ({ data: { current_token_ownerships_v2: rows } }) })
    let fetchMock: ReturnType<typeof vi.fn>
    beforeEach(() => {
      fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)
    })

    it("400s on anything but a 64-hex Aptos account", async () => {
      expect((await GET(req("https://t/api/ufc/aptos-holdings?aptos=0x8c84d174d73e2d4c"))).status).toBe(400)
    })

    it("keeps only UFC Strike tokens, prices them, and never consults the Flow link table", async () => {
      db.colls = [{ edition_id: "e1", aptos_collection_id: "0xufc" }]
      db.editions = [{ id: "e1", external_id: "733", name: "X", player_name: "X", set_name: "S", tier: null, circulation_count: null, thumbnail_url: null }]
      db.fmv = [{ edition_id: "e1", fmv_usd: 2 }]
      fetchMock.mockResolvedValueOnce(page([
        { token_data_id: "0xt1", current_token_data: { collection_id: "0xufc", token_properties: { "Serial Number": "12" } } },
        { token_data_id: "0xt2", current_token_data: { collection_id: "0xnotufc", token_properties: {} } },
      ]))
      const body = await (await GET(req(`https://t/api/ufc/aptos-holdings?aptos=${APT.toUpperCase().replace("0X", "0x")}`))).json()
      expect(body.linked).toBe(true)
      expect(body.count).toBe(1)
      expect(body.moments[0].serial_number).toBe(12)
      expect(body.total_fmv).toBe(2)
      expect(db.rpcCalls.some((c) => c.name === "get_ufc_aptos_holdings_for_flow")).toBe(false)
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables.o).toBe(APT)
    })

    it("a failed indexer read is an error, never an empty account", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      const res = await GET(req(`https://t/api/ufc/aptos-holdings?aptos=${APT}`))
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(await res.json()).not.toHaveProperty("linked")
    })
  })

  it("pages past PostgREST's 1,000-row RPC cap on a unique key", async () => {
    db.holdings = Array.from({ length: 1500 }, (_, i) => ({ token_data_id: "0x" + String(i).padStart(5, "0"), edition_id: null, serial_number: i }))
    const body = await (await GET(req(`https://t/api/ufc/aptos-holdings?wallet=${WALLET}`))).json()
    expect(body.count).toBe(1500)
    const pages = db.rpcCalls.filter((c) => c.name === "get_ufc_aptos_holdings_for_flow").map((c) => c.range)
    expect(pages).toEqual([[0, 999], [1000, 1999]])
  })
})
