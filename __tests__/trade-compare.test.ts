import { describe, it, expect } from "vitest"
import { buildSide, quickTrade, closeEnough, coverage, type CandidateRow, type ChainState } from "@/lib/trade-compare/compare"
import { readHoldingsParallel } from "@/lib/trade-compare/read"

// 2026-11-16: /trades/compare — what two collectors could trade, checked on chain, priced on FMV.

function row(p: Partial<CandidateRow> & { moment_id: string; edition_key: string }): CandidateRow {
  return {
    serial_number: null,
    player_name: "P",
    set_name: "S",
    tier: "RARE",
    series_number: 8,
    image_url: null,
    league: "NBA",
    fmv_usd: 10,
    fmv_confidence: "HIGH",
    owned: 2,
    cached_locked: 0,
    ...p,
  }
}

function chain(held: Record<string, boolean | "locked" | "gone">, listed: string[] = []): ChainState {
  const holdings: ChainState["holdings"] = {}
  for (const [id, v] of Object.entries(held)) {
    if (v === "gone") holdings[id] = { held: false, locked: null }
    else holdings[id] = { held: true, locked: v === "locked" }
  }
  return { holdings, listed: new Set(listed) }
}

describe("buildSide", () => {
  it("never offers the last copy: two free copies of a two-copy edition offer ONE, keeping the lowest serial", () => {
    const s = buildSide(
      [row({ moment_id: "1", edition_key: "e", serial_number: 5 }), row({ moment_id: "2", edition_key: "e", serial_number: 90 })],
      chain({ "1": true, "2": true }),
    )
    expect(s.editions).toHaveLength(1)
    expect(s.editions[0].tradeable.map((c) => c.moment_id)).toEqual(["2"])
  })

  it("a copy RPC last saw locked counts as the kept copy, so the free one is offered", () => {
    const s = buildSide([row({ moment_id: "1", edition_key: "e", owned: 2, cached_locked: 1, serial_number: 3 })], chain({ "1": true }))
    expect(s.editions[0].tradeable.map((c) => c.moment_id)).toEqual(["1"])
  })

  it("locked, listed and gone copies are never tradeable — the chain decides, not the cache", () => {
    const s = buildSide(
      [
        row({ moment_id: "1", edition_key: "e", owned: 4 }),
        row({ moment_id: "2", edition_key: "e", owned: 4 }),
        row({ moment_id: "3", edition_key: "e", owned: 4 }),
        row({ moment_id: "4", edition_key: "e", owned: 4 }),
      ],
      chain({ "1": "locked", "2": true, "3": "gone", "4": true }, ["4"]),
    )
    expect(s.editions[0].tradeable.map((c) => c.moment_id)).toEqual(["2"])
    expect(s.blocked).toEqual({ locked: 1, listed: 1, gone: 1 })
  })

  it("a candidate missing from the chain answer is gone, never tradeable", () => {
    const s = buildSide([row({ moment_id: "1", edition_key: "e", owned: 3 }), row({ moment_id: "2", edition_key: "e", owned: 3 })], chain({ "1": true }))
    expect(s.editions[0].tradeable.map((c) => c.moment_id)).toEqual(["1"])
    expect(s.blocked.gone).toBe(1)
  })

  it("an edition whose only held copy is free offers nothing (the gone copies don't count as kept)", () => {
    const s = buildSide([row({ moment_id: "1", edition_key: "e", owned: 2 }), row({ moment_id: "2", edition_key: "e", owned: 2 })], chain({ "1": true, "2": "gone" }))
    expect(s.editions).toHaveLength(0)
  })

  it("a missing FMV is not priced (null), never $0; ask-derived carries from_asks; the tier itself is not on the edition", () => {
    const s = buildSide(
      [
        row({ moment_id: "1", edition_key: "a", fmv_usd: null, fmv_confidence: "NO_DATA", owned: 3 }),
        row({ moment_id: "2", edition_key: "b", fmv_usd: "4.23", fmv_confidence: "ASK_ONLY", owned: 3 }),
      ],
      chain({ "1": true, "2": true }),
    )
    const a = s.editions.find((e) => e.edition_key === "a")!
    const b = s.editions.find((e) => e.edition_key === "b")!
    expect(a.fmv_usd).toBeNull()
    expect(b.fmv_usd).toBe(4.23)
    expect(b.from_asks).toBe(true)
    expect(JSON.stringify(s.editions)).not.toMatch(/confidence|HIGH|MEDIUM|ASK_ONLY|NO_DATA/)
    expect(s.confident.size).toBe(0)
  })
})

describe("quickTrade", () => {
  const side = (rows: CandidateRow[]) => buildSide(rows, chain(Object.fromEntries(rows.map((r) => [r.moment_id, true]))))

  it("pairs only confidently priced editions — an ask-only $7.40 is never called even with a $7.50", () => {
    const a = side([row({ moment_id: "1", edition_key: "tre", fmv_usd: 7.4, fmv_confidence: "ASK_ONLY", owned: 3 })])
    const b = side([row({ moment_id: "2", edition_key: "iggy", fmv_usd: 7.5, fmv_confidence: "MEDIUM", owned: 3 })])
    expect(quickTrade(a.editions, b.editions, a.confident, b.confident)).toBeNull()
  })

  it("picks the most valuable close pair, and the copy offered is the highest serial", () => {
    const a = side([
      row({ moment_id: "1", edition_key: "x", fmv_usd: 6, owned: 3, serial_number: 10 }),
      row({ moment_id: "1b", edition_key: "x", fmv_usd: 6, owned: 3, serial_number: 200 }),
      row({ moment_id: "3", edition_key: "y", fmv_usd: 100, owned: 3 }),
    ])
    const b = side([row({ moment_id: "2", edition_key: "z", fmv_usd: 6.5, owned: 3 }), row({ moment_id: "4", edition_key: "w", fmv_usd: 95, owned: 3 })])
    const q = quickTrade(a.editions, b.editions, a.confident, b.confident)!
    expect(q.a.edition_key).toBe("y")
    expect(q.b.edition_key).toBe("w")
    expect(q.difference_usd).toBe(5)
    const q2 = quickTrade(a.editions.filter((e) => e.edition_key === "x"), b.editions.filter((e) => e.edition_key === "z"), a.confident, b.confident)!
    expect(q2.a.moment_id).toBe("1b")
  })

  it("refuses a pair that is not close (a $5.2M side made of one $100,000 ask cannot happen here)", () => {
    const a = side([row({ moment_id: "1", edition_key: "x", fmv_usd: 10 })])
    const b = side([row({ moment_id: "2", edition_key: "y", fmv_usd: 100_000 })])
    expect(quickTrade(a.editions, b.editions, a.confident, b.confident)).toBeNull()
  })

  it("closeEnough: within $1 or 10 %", () => {
    expect(closeEnough(4.23, 5)).toBe(true)
    expect(closeEnough(4.23, 6)).toBe(false)
    expect(closeEnough(100, 109)).toBe(true)
    expect(closeEnough(100, 112)).toBe(false)
  })
})

describe("coverage", () => {
  it("an unreadable chain count is unknown, never complete", () => {
    expect(coverage(10, null)).toEqual({ indexed: 10, on_chain: null, complete: null })
    expect(coverage(10, 12).complete).toBe(false)
    expect(coverage(12, 12).complete).toBe(true)
  })
})

describe("readHoldingsParallel", () => {
  it("a failed chunk fails the whole read — never a partial answer", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i + 1))
    let n = 0
    const read = async (_a: string, chunk: readonly string[]) => {
      n++
      if (n === 2) throw new Error("Flow script HTTP 503")
      return Object.fromEntries(chunk.map((id) => [id, { held: true, locked: false }]))
    }
    await expect(readHoldingsParallel("0x0000000000000001", ids, read)).rejects.toThrow(/503/)
  })

  it("reads every id across chunks", async () => {
    const ids = Array.from({ length: 260 }, (_, i) => String(i + 1))
    const read = async (_a: string, chunk: readonly string[]) => Object.fromEntries(chunk.map((id) => [id, { held: true, locked: false }]))
    const out = await readHoldingsParallel("0x0000000000000001", ids, read)
    expect(Object.keys(out)).toHaveLength(260)
  })
})
