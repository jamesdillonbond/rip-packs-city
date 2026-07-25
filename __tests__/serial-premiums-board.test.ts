import { describe, it, expect } from "vitest"
import {
  parseHeadlineMode,
  selectCols,
  normalizeRow,
  fetchSerialPremiums,
  BOARDS,
} from "@/lib/serial-premiums-board"

// The #1-serial vs perfect-mint premiums board. parseHeadlineMode validates the
// query param; selectCols picks mode-specific columns; normalizeRow coerces the
// raw DB row into a typed shape (headline_serial defaults to 1 for the #1 board).

describe("parseHeadlineMode", () => {
  it("only 'perfect' selects the perfect board; everything else → no1", () => {
    expect(parseHeadlineMode("perfect")).toBe("perfect")
    expect(parseHeadlineMode("PERFECT")).toBe("perfect")
    expect(parseHeadlineMode("no1")).toBe("no1")
    expect(parseHeadlineMode(null)).toBe("no1")
    expect(parseHeadlineMode("bogus")).toBe("no1")
  })
})

describe("selectCols", () => {
  it("includes shared cols + mode-specific sale cols", () => {
    const no1 = selectCols("no1")
    const perfect = selectCols("perfect")
    expect(no1).toContain("edition_id")
    // the perfect board carries a serial column the no1 board does not
    expect(perfect).toContain("perfect_serial")
    expect(no1).not.toContain("perfect_serial")
  })
})

describe("normalizeRow", () => {
  it("no1 mode defaults headline_serial to 1 and coerces numerics", () => {
    const row = normalizeRow("no1", {
      edition_id: "e1",
      circulation_count: "250",
      premium_multiple: "3.5",
      no1_last_sale_usd: "500",
      is_conflated: true,
    })
    expect(row.edition_id).toBe("e1")
    expect(row.circulation_count).toBe(250)
    expect(row.premium_multiple).toBe(3.5)
    expect(row.headline_serial).toBe(1)
    expect(row.is_conflated).toBe(true)
  })

  it("perfect mode reads the perfect serial + sale columns", () => {
    const row = normalizeRow("perfect", {
      perfect_serial: "77",
      perfect_last_sale_usd: "900",
    })
    expect(row.headline_serial).toBe(77)
    expect(row.headline_last_sale_usd).toBe(900)
  })

  it("coerces empty/invalid numerics to null", () => {
    const row = normalizeRow("no1", { circulation_count: "", premium_multiple: "abc" })
    expect(row.circulation_count).toBeNull()
    expect(row.premium_multiple).toBeNull()
  })
})

// ── fetchSerialPremiums: the query the two public boards are built from ──────
// Two views back one board, and the ONLY thing that keeps them apart is that
// every filter/sort has to be applied against the MODE'S OWN columns. A sort
// that fell back to the #1 board's column while the perfect board was selected
// would silently order the page by the wrong sale — visibly plausible, entirely
// wrong. This captures the built query so each of those bindings is asserted.

interface Recorded {
  table: string
  select: string
  gte: Array<[string, unknown]>
  eq: Array<[string, unknown]>
  order: Array<[string, unknown]>
  limit: number | null
}

function recordingSupabase(result: { data: unknown; error?: { message: string } | null }) {
  const rec: Recorded = { table: "", select: "", gte: [], eq: [], order: [], limit: null }
  const qb: Record<string, unknown> = {}
  const self = () => qb
  qb.select = (c: string) => { rec.select = c; return self() }
  qb.gte = (c: string, v: unknown) => { rec.gte.push([c, v]); return self() }
  qb.eq = (c: string, v: unknown) => { rec.eq.push([c, v]); return self() }
  qb.order = (c: string, v: unknown) => { rec.order.push([c, v]); return self() }
  qb.limit = (n: number) => { rec.limit = n; return self() }
  ;(qb as { then: unknown }).then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ error: null, ...result }).then(res)
  return { rec, sb: { from: (t: string) => { rec.table = t; return qb } } }
}

const baseOpts = { mode: "no1" as const, windowDays: 30, minPremium: 5, sort: "premium" as const, limit: 25 }

describe("fetchSerialPremiums", () => {
  it("queries the #1 board and normalizes its rows", async () => {
    const { rec, sb } = recordingSupabase({
      data: [{ edition_id: "e1", premium_multiple: "7.5", no1_last_sale_usd: "900", no1_sold_at: "2026-07-01" }],
    })
    const rows = await fetchSerialPremiums(sb, baseOpts)

    expect(rec.table).toBe(BOARDS.no1.table)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ headline_serial: 1, headline_last_sale_usd: 900, premium_multiple: 7.5 })
  })

  it("binds every filter and sort to the SELECTED mode's own columns", async () => {
    const { rec, sb } = recordingSupabase({ data: [] })
    await fetchSerialPremiums(sb, { ...baseOpts, mode: "perfect", sort: "headline_price", limit: 10 })

    expect(rec.table).toBe(BOARDS.perfect.table)
    // The recency window filters the perfect board's sold_at, not the #1 one.
    expect(rec.gte.map(([c]) => c)).toContain(BOARDS.perfect.soldAtCol)
    expect(rec.gte.map(([c]) => c)).not.toContain(BOARDS.no1.soldAtCol)
    // headline_price sorts by the perfect board's sale column.
    expect(rec.order[0][0]).toBe(BOARDS.perfect.saleCol)
    expect(rec.limit).toBe(10)
  })

  it("maps each sort key to its column and always filters on premium_multiple", async () => {
    for (const [sort, col] of [
      ["premium", "premium_multiple"],
      ["headline_price", BOARDS.no1.saleCol],
      ["recent", BOARDS.no1.soldAtCol],
    ] as const) {
      const { rec, sb } = recordingSupabase({ data: [] })
      await fetchSerialPremiums(sb, { ...baseOpts, sort })
      expect(rec.order[0]).toEqual([col, { ascending: false }])
      expect(rec.gte.find(([c]) => c === "premium_multiple")?.[1]).toBe(5)
    }
  })

  it("adds a tier filter only when one is supplied", async () => {
    const withTier = recordingSupabase({ data: [] })
    await fetchSerialPremiums(withTier.sb, { ...baseOpts, tier: "LEGENDARY" })
    expect(withTier.rec.eq).toContainEqual(["tier", "LEGENDARY"])

    for (const tier of [null, undefined, ""]) {
      const none = recordingSupabase({ data: [] })
      await fetchSerialPremiums(none.sb, { ...baseOpts, tier })
      expect(none.rec.eq).toHaveLength(0)
    }
  })

  it("derives the recency cutoff from windowDays", async () => {
    const { rec, sb } = recordingSupabase({ data: [] })
    const before = Date.now()
    await fetchSerialPremiums(sb, { ...baseOpts, windowDays: 7 })
    const cutoff = new Date(String(rec.gte.find(([c]) => c === BOARDS.no1.soldAtCol)?.[1])).getTime()
    expect(before - cutoff).toBeGreaterThanOrEqual(7 * 86400000 - 5000)
    expect(before - cutoff).toBeLessThan(7 * 86400000 + 5000)
  })

  it("returns [] for a null payload and THROWS on a query error", async () => {
    const empty = recordingSupabase({ data: null })
    expect(await fetchSerialPremiums(empty.sb, baseOpts)).toEqual([])

    const bad = recordingSupabase({ data: null, error: { message: "board view missing" } })
    await expect(fetchSerialPremiums(bad.sb, baseOpts)).rejects.toThrow("board view missing")
  })
})
