import { describe, it, expect } from "vitest"
import {
  parseHeadlineMode,
  parseQuality,
  parseSort,
  fetchUnderpricedSerials,
} from "@/lib/underpriced-serials-board"

// Underpriced #1s / perfect-mints board query-param parsers. Locks the exact
// fallback: unlike serial-premiums-board (which defaults to "no1"), the headline
// mode here defaults to "all"; "first" is an alias for "no1"; all three parsers
// are case/whitespace-insensitive and fall through to their default.

describe("parseHeadlineMode", () => {
  it("maps no1/first → no1, perfect → perfect, everything else → all", () => {
    expect(parseHeadlineMode("no1")).toBe("no1")
    expect(parseHeadlineMode("first")).toBe("no1")
    expect(parseHeadlineMode("perfect")).toBe("perfect")
    expect(parseHeadlineMode("all")).toBe("all")
    expect(parseHeadlineMode(null)).toBe("all")
    expect(parseHeadlineMode(undefined)).toBe("all")
    expect(parseHeadlineMode("bogus")).toBe("all")
  })

  it("is case- and whitespace-insensitive", () => {
    expect(parseHeadlineMode("  PERFECT ")).toBe("perfect")
    expect(parseHeadlineMode("First")).toBe("no1")
  })
})

describe("parseQuality", () => {
  it("only tight/coarse pass through; else → all", () => {
    expect(parseQuality("tight")).toBe("tight")
    expect(parseQuality("coarse")).toBe("coarse")
    expect(parseQuality("all")).toBe("all")
    expect(parseQuality(null)).toBe("all")
    expect(parseQuality("TIGHT")).toBe("tight")
    expect(parseQuality("nonsense")).toBe("all")
  })
})

describe("parseSort", () => {
  it("ask/recent pass through; default (incl. 'discount') → discount", () => {
    expect(parseSort("ask")).toBe("ask")
    expect(parseSort("recent")).toBe("recent")
    expect(parseSort("discount")).toBe("discount")
    expect(parseSort(null)).toBe("discount")
    expect(parseSort("Recent")).toBe("recent")
    expect(parseSort("whatever")).toBe("discount")
  })
})

// fetchUnderpricedSerials builds a PostgREST query (from().select().gte()...
// .order().limit()) then awaits it, and applies the #1-vs-perfect headline split
// + limit slice in JS. A chainable thenable builder that records calls fakes the
// client — no vi.mock.
function upClient(data: any[] | null, error: any = null) {
  const calls: Array<{ m: string; args: any[] }> = []
  const builder: any = {}
  for (const m of ["select", "gte", "eq", "order", "limit"]) {
    builder[m] = (...args: any[]) => {
      calls.push({ m, args })
      return builder
    }
  }
  builder.then = (res: (r: any) => any) => res({ data, error })
  return { from: (t: string) => (calls.push({ m: "from", args: [t] }), builder), calls }
}

const upOpts = {
  headline: "all" as const,
  quality: "all" as const,
  minDiscount: 10,
  sort: "discount" as const,
  limit: 50,
}

// A row with serial 1 normalizes to kind "first"; anything else → "perfect".
const row = (serial: number, extra: Record<string, unknown> = {}) => ({
  edition_id: `e${serial}`,
  serial_number: serial,
  nft_id: `nft${serial}`,
  ...extra,
})

describe("fetchUnderpricedSerials", () => {
  it("throws when the query returns an error", async () => {
    await expect(fetchUnderpricedSerials(upClient(null, { message: "up boom" }), upOpts)).rejects.toThrow("up boom")
  })

  it("returns [] for null/empty data", async () => {
    expect(await fetchUnderpricedSerials(upClient(null), upOpts)).toEqual([])
    expect(await fetchUnderpricedSerials(upClient([]), upOpts)).toEqual([])
  })

  it("applies the minDiscount gte and default discount order; tier/quality omitted when 'all'/absent", async () => {
    const sb = upClient([])
    await fetchUnderpricedSerials(sb, upOpts)
    const gte = sb.calls.find((c) => c.m === "gte")!
    expect(gte.args).toEqual(["discount_pct", 10])
    expect(sb.calls.some((c) => c.m === "eq")).toBe(false) // no tier, quality=all
    const order = sb.calls.find((c) => c.m === "order")!
    expect(order.args[0]).toBe("discount_pct")
    // pulls a generous 500-row slice DB-side before the JS headline trim
    expect(sb.calls.find((c) => c.m === "limit")!.args[0]).toBe(500)
  })

  it("adds tier + quality eq filters and switches order column by sort", async () => {
    const askSb = upClient([])
    await fetchUnderpricedSerials(askSb, { ...upOpts, tier: "RARE", quality: "tight", sort: "ask" })
    const eq = askSb.calls.filter((c) => c.m === "eq").map((c) => c.args)
    expect(eq).toContainEqual(["tier", "RARE"])
    expect(eq).toContainEqual(["estimate_quality", "tight"])
    expect(askSb.calls.find((c) => c.m === "order")!.args).toEqual(["ask_usd", { ascending: true }])

    const recentSb = upClient([])
    await fetchUnderpricedSerials(recentSb, { ...upOpts, sort: "recent" })
    expect(recentSb.calls.find((c) => c.m === "order")!.args[0]).toBe("listed_at")
  })

  it("normalizes kind from serial (1→first, else perfect) and builds a dapper.market fallback listing_url", async () => {
    const rows = await fetchUnderpricedSerials(upClient([row(1), row(77)]), upOpts)
    expect(rows.map((r) => r.kind)).toEqual(["first", "perfect"])
    expect(rows[0].listing_url).toBe("https://dapper.market/nba/moment/nft1")
  })

  it("prefers an explicit listing_url over the fallback", async () => {
    const rows = await fetchUnderpricedSerials(
      upClient([row(1, { listing_url: "https://example.com/l" })]),
      upOpts,
    )
    expect(rows[0].listing_url).toBe("https://example.com/l")
  })

  it("headline=no1 keeps only #1s; perfect keeps only perfect", async () => {
    const data = [row(1), row(50), row(1)]
    expect((await fetchUnderpricedSerials(upClient(data), { ...upOpts, headline: "no1" })).map((r) => r.serial_number)).toEqual([1, 1])
    expect((await fetchUnderpricedSerials(upClient(data), { ...upOpts, headline: "perfect" })).map((r) => r.serial_number)).toEqual([50])
  })

  it("trims to the JS limit AFTER the headline filter", async () => {
    const data = [row(1), row(2), row(3), row(4)]
    const rows = await fetchUnderpricedSerials(upClient(data), { ...upOpts, limit: 2 })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.edition_id)).toEqual(["e1", "e2"])
  })
})
