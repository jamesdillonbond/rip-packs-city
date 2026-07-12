import { describe, it, expect } from "vitest"
import { normalizeRow, PARALLEL_ORDER, fetchRookieEditionBoard } from "@/lib/rookie-edition-board"

// Rookie Edition Board row normalizer + parallel display-order map (skipping the
// DB fetch). Locks: numeric coercion (empty/invalid/null → null), string
// passthrough with null fallback, strict boolean coercion of has_full_economics
// (only literal true counts), and the Standard-first parallel ordering.

describe("normalizeRow", () => {
  it("coerces numeric strings and passes strings through", () => {
    const row = normalizeRow({
      player_name: "Cooper Flagg",
      set_name: "Base Set",
      series_number: "8",
      tier: "COMMON",
      parallel_id: "19",
      circulation_count: "1000",
      fmv_usd: "42.5",
      external_id: "233:8121::19",
      has_full_economics: false,
    })
    expect(row.player_name).toBe("Cooper Flagg")
    expect(row.series_number).toBe(8)
    expect(row.parallel_id).toBe(19)
    expect(row.circulation_count).toBe(1000)
    expect(row.fmv_usd).toBe(42.5)
    expect(row.external_id).toBe("233:8121::19")
  })

  it("coerces empty / invalid / missing numerics to null", () => {
    const row = normalizeRow({ fmv_usd: "", circulation_count: "abc" })
    expect(row.fmv_usd).toBeNull()
    expect(row.circulation_count).toBeNull()
    expect(row.burned).toBeNull() // absent key
  })

  it("defaults missing string fields to null", () => {
    const row = normalizeRow({})
    expect(row.player_name).toBeNull()
    expect(row.tier).toBeNull()
    expect(row.thumbnail_url).toBeNull()
  })

  it("has_full_economics is strictly boolean — only literal true", () => {
    expect(normalizeRow({ has_full_economics: true }).has_full_economics).toBe(true)
    expect(normalizeRow({ has_full_economics: "true" }).has_full_economics).toBe(false)
    expect(normalizeRow({ has_full_economics: 1 }).has_full_economics).toBe(false)
    expect(normalizeRow({}).has_full_economics).toBe(false)
  })
})

describe("PARALLEL_ORDER", () => {
  it("orders Standard(0) first, then ascending rarity by subedition id", () => {
    expect(PARALLEL_ORDER[0]).toBe(0)
    expect(PARALLEL_ORDER[17]).toBe(1)
    expect(PARALLEL_ORDER[22]).toBe(6)
    // strictly increasing across the known subedition ids
    const ids = [0, 17, 18, 19, 20, 21, 22]
    const ranks = ids.map((i) => PARALLEL_ORDER[i])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

// fetchRookieEditionBoard builds a PostgREST query (from().select().eq()...
// .order().limit()) then awaits it. A chainable thenable builder that records
// every call fakes the client — no vi.mock. `calls` lets us assert which
// filters/order/limit the fetcher applied for a given FetchOpts.
function rookieClient(data: any[] | null, error: any = null) {
  const calls: Array<{ m: string; args: any[] }> = []
  const builder: any = {}
  for (const m of ["select", "eq", "gt", "order", "limit"]) {
    builder[m] = (...args: any[]) => {
      calls.push({ m, args })
      return builder
    }
  }
  builder.then = (res: (r: any) => any) => res({ data, error })
  return { from: (t: string) => (calls.push({ m: "from", args: [t] }), builder), calls }
}

const baseOpts = { mode: "board" as const, sort: "fmv" as const, limit: 50 }

describe("fetchRookieEditionBoard", () => {
  it("throws when the query returns an error", async () => {
    const sb = rookieClient(null, { message: "board boom" })
    await expect(fetchRookieEditionBoard(sb, baseOpts)).rejects.toThrow("board boom")
  })

  it("returns [] for null/empty data", async () => {
    expect(await fetchRookieEditionBoard(rookieClient(null), baseOpts)).toEqual([])
    expect(await fetchRookieEditionBoard(rookieClient([]), baseOpts)).toEqual([])
  })

  it("normalizes returned rows via normalizeRow", async () => {
    const sb = rookieClient([
      { player_name: "Flagg", fmv_usd: "42.5", circulation_count: "1000", has_full_economics: true },
    ])
    const rows = await fetchRookieEditionBoard(sb, baseOpts)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ player_name: "Flagg", fmv_usd: 42.5, circulation_count: 1000, has_full_economics: true })
  })

  it("board mode: no burn filter, default fmv order, applies limit", async () => {
    const sb = rookieClient([])
    await fetchRookieEditionBoard(sb, { ...baseOpts, limit: 25 })
    const methods = sb.calls.map((c) => c.m)
    expect(methods).not.toContain("gt") // no burned>0 filter in board mode
    const order = sb.calls.find((c) => c.m === "order")!
    expect(order.args[0]).toBe("fmv_usd")
    expect(order.args[1]).toMatchObject({ ascending: false })
    const limit = sb.calls.find((c) => c.m === "limit")!
    expect(limit.args[0]).toBe(25)
  })

  it("burn mode restricts to has_full_economics=true AND burned>0", async () => {
    const sb = rookieClient([])
    await fetchRookieEditionBoard(sb, { ...baseOpts, mode: "burn", sort: "burned" })
    const eqCalls = sb.calls.filter((c) => c.m === "eq")
    expect(eqCalls).toContainEqual({ m: "eq", args: ["has_full_economics", true] })
    const gt = sb.calls.find((c) => c.m === "gt")!
    expect(gt.args).toEqual(["burned", 0])
    const order = sb.calls.find((c) => c.m === "order")!
    expect(order.args[0]).toBe("burned")
  })

  it("applies drill-down filters (tier/parallelId/player/set) as eq clauses", async () => {
    const sb = rookieClient([])
    await fetchRookieEditionBoard(sb, {
      ...baseOpts,
      tier: "RARE",
      parallelId: 19,
      player: "Flagg",
      set: "Base Set",
    })
    const eq = sb.calls.filter((c) => c.m === "eq").map((c) => c.args)
    expect(eq).toContainEqual(["tier", "RARE"])
    expect(eq).toContainEqual(["parallel_id", 19])
    expect(eq).toContainEqual(["player_name", "Flagg"])
    expect(eq).toContainEqual(["set_name", "Base Set"])
  })

  it("parallelId=0 is applied (not treated as absent)", async () => {
    const sb = rookieClient([])
    await fetchRookieEditionBoard(sb, { ...baseOpts, parallelId: 0 })
    const eq = sb.calls.filter((c) => c.m === "eq").map((c) => c.args)
    expect(eq).toContainEqual(["parallel_id", 0])
  })

  it("maps each sort key to the right order column", async () => {
    const cases: Array<[any, string, boolean]> = [
      ["burn_rate", "burn_rate_pct", false],
      ["lock_rate", "lock_rate_pct", false],
      ["circulation", "circulation_count", true],
      ["fmv", "fmv_usd", false],
    ]
    for (const [sort, col, asc] of cases) {
      const sb = rookieClient([])
      await fetchRookieEditionBoard(sb, { ...baseOpts, sort })
      const order = sb.calls.find((c) => c.m === "order")!
      expect(order.args[0]).toBe(col)
      expect(order.args[1].ascending).toBe(asc)
    }
  })
})
