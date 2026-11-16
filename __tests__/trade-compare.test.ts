import { describe, it, expect, vi } from "vitest"
import { buildSide, quickTrade, closeEnough, coverage, type CandidateRow, type ChainState } from "@/lib/trade-compare/compare"
import { readHoldingsParallel, readIndexedListed, readChain, compareCollection, readOnChainCount } from "@/lib/trade-compare/read"
import { memorySupabase } from "./helpers/memory-supabase"

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

describe("per collection (2026-11-16 afternoon)", () => {
  const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"

  it("covers Top Shot, All Day and Golazos only — UFC (closed market) and anything else is null", () => {
    expect(compareCollection("nba-top-shot")?.collectionId).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
    expect(compareCollection("nfl-all-day")?.collectionId).toBe(AD)
    expect(compareCollection("laliga-golazos")?.short).toBe("Golazos")
    for (const v of ["ufc", "disney-pinnacle", "", null, "nba_top_shot"]) expect(compareCollection(v as string | null)).toBeNull()
  })

  it("All Day listings come from the index: open, unexpired rows of THAT seller in THAT collection", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    // (flow_id is bigint in Postgres, which casts the string ids; the in-memory double compares exactly)
    const m = memorySupabase({
      cached_listings_v2: [
        { collection_id: AD, seller_address: "0xa", flow_id: "1", completed_at: null, expiry_at: future },
        { collection_id: AD, seller_address: "0xa", flow_id: "2", completed_at: "2026-11-01T00:00:00Z", expiry_at: null },
        { collection_id: AD, seller_address: "0xa", flow_id: "3", completed_at: null, expiry_at: past },
        { collection_id: AD, seller_address: "0xb", flow_id: "4", completed_at: null, expiry_at: null },
        { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", seller_address: "0xa", flow_id: "5", completed_at: null, expiry_at: null },
      ],
    })
    const got = await readIndexedListed(m.db, AD, "0xa", ["1", "2", "3", "4", "5"])
    expect([...got]).toEqual(["1"])
  })

  it("a failed listings read throws (never 'not listed')", async () => {
    const m = memorySupabase({ cached_listings_v2: [] })
    m.failNext("select", "cached_listings_v2", "boom")
    await expect(readIndexedListed(m.db, AD, "0xa", ["1"])).rejects.toThrow(/boom/)
  })

  it("readChain uses the collection's own readers and reads nothing for no candidates", async () => {
    const m = memorySupabase({})
    const holdings = vi.fn(async (_a: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }])))
    const listed = vi.fn(async () => new Set(["7"]))
    const c = compareCollection("nfl-all-day")!
    const out = await readChain(m.db, c, "0xa", [row({ moment_id: "7", edition_key: "e" })], { holdings, listed })
    expect(out.listed.has("7")).toBe(true)
    expect(holdings).toHaveBeenCalledWith("0xa", ["7"])
    const none = await readChain(m.db, c, "0xa", [], { holdings, listed })
    expect(Object.keys(none.holdings)).toHaveLength(0)
    expect(holdings).toHaveBeenCalledTimes(1)
  })

  it("Golazos' on-chain count is read by its own script; an unreadable answer is null, never 0", async () => {
    const answer = (v: unknown, ok = true) => vi.fn(async () => ({ ok, text: async () => `"${btoa(JSON.stringify(v))}"` }) as unknown as Response)
    const gz = compareCollection("laliga-golazos")!
    expect(await readOnChainCount("0x0000000000000001", gz, answer({ type: "Int", value: "45" }))).toBe(45)
    expect(await readOnChainCount("0x0000000000000001", gz, answer({ type: "Int", value: "-1" }))).toBe(0)
    expect(await readOnChainCount("0x0000000000000001", gz, answer({ type: "String", value: "x" }))).toBeNull()
    expect(await readOnChainCount("0x0000000000000001", gz, answer({}, false))).toBeNull()
  })
})
