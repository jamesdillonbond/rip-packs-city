import { describe, it, expect } from "vitest"
import { fetchParallelPremiums } from "@/lib/parallel-premiums-board"

// The public Parallel Premiums board (TopShot ::subID parallels priced vs their
// Standard base). fetchParallelPremiums queries a read-only view via a chainable
// Supabase client. These tests pin the row normalization / numeric coercion, the
// conditional filter+sort branches (highConfOnly / parallelName / each sort key),
// and the empty + error paths using a fake thenable query builder.

// A chainable, thenable fake of the PostgREST query builder. Every method records
// its call and returns `this`; awaiting it resolves to { data, error }. `calls`
// lets a test assert which conditional branches were taken.
function makeClient(data: any, error: any = null) {
  const calls: Array<[string, any[]]> = []
  const q: any = {
    then(res: any, rej: any) {
      return Promise.resolve({ data, error }).then(res, rej)
    },
  }
  for (const m of ["from", "select", "not", "gte", "eq", "order", "limit"]) {
    q[m] = (...args: any[]) => {
      calls.push([m, args])
      return q
    }
  }
  return { q, calls }
}

const baseOpts = {
  minPremium: 1.5,
  highConfOnly: false,
  sort: "premium" as const,
  limit: 25,
}

describe("fetchParallelPremiums", () => {
  it("throws when the query errors", async () => {
    const { q } = makeClient(null, { message: "view boom" })
    await expect(fetchParallelPremiums(q, baseOpts)).rejects.toThrow("view boom")
  })

  it("returns [] for null data", async () => {
    const { q } = makeClient(null)
    expect(await fetchParallelPremiums(q, baseOpts)).toEqual([])
  })

  it("normalizes a raw row: coerces numerics, defaults nulls, both_high_conf strict-true", async () => {
    const { q } = makeClient([
      {
        edition_id: "e1",
        external_id: "233:8121::19",
        base_ext: "233:8121",
        player_name: "Player",
        set_name: "Set",
        series: "8",
        tier: "RARE",
        subedition_name: "Hexwave",
        parallel_circ: "60",
        base_circ: "1000",
        base_fmv: "10",
        base_confidence: "HIGH",
        parallel_fmv: "35",
        parallel_confidence: "MEDIUM",
        premium_mult: "3.5",
        both_high_conf: true,
        thumbnail_url: "http://x/t.png",
      },
    ])
    const [row] = await fetchParallelPremiums(q, baseOpts)
    expect(row).toEqual({
      edition_id: "e1",
      external_id: "233:8121::19",
      base_ext: "233:8121",
      player_name: "Player",
      set_name: "Set",
      series: 8,
      tier: "RARE",
      subedition_name: "Hexwave",
      parallel_circ: 60,
      base_circ: 1000,
      base_fmv: 10,
      base_confidence: "HIGH",
      parallel_fmv: 35,
      parallel_confidence: "MEDIUM",
      premium_mult: 3.5,
      both_high_conf: true,
      thumbnail_url: "http://x/t.png",
    })
  })

  it("coerces empty/invalid numerics to null and null-defaults strings; both_high_conf non-true → false", async () => {
    const { q } = makeClient([
      {
        series: "",
        parallel_circ: "abc",
        premium_mult: null,
        both_high_conf: "true", // string, not strict boolean true
      },
    ])
    const [row] = await fetchParallelPremiums(q, baseOpts)
    expect(row.series).toBeNull()
    expect(row.parallel_circ).toBeNull()
    expect(row.premium_mult).toBeNull()
    expect(row.edition_id).toBeNull()
    expect(row.player_name).toBeNull()
    expect(row.both_high_conf).toBe(false)
  })

  it("applies base filters + default premium sort, no eq() when flags off", async () => {
    const { q, calls } = makeClient([])
    await fetchParallelPremiums(q, baseOpts)
    const names = calls.map((c) => c[0])
    expect(names).toContain("not")
    expect(names).toContain("gte")
    expect(names).not.toContain("eq")
    // default sort orders by premium_mult desc
    const order = calls.find((c) => c[0] === "order")!
    expect(order[1][0]).toBe("premium_mult")
    expect(order[1][1]).toEqual({ ascending: false })
    // gte gets the minPremium floor and limit gets opts.limit
    expect(calls.find((c) => c[0] === "gte")![1]).toEqual(["premium_mult", 1.5])
    expect(calls.find((c) => c[0] === "limit")![1]).toEqual([25])
  })

  it("highConfOnly + parallelName add two eq() filters", async () => {
    const { q, calls } = makeClient([])
    await fetchParallelPremiums(q, { ...baseOpts, highConfOnly: true, parallelName: "Cosmic" })
    const eqs = calls.filter((c) => c[0] === "eq").map((c) => c[1])
    expect(eqs).toContainEqual(["both_high_conf", true])
    expect(eqs).toContainEqual(["subedition_name", "Cosmic"])
  })

  it("sort=parallel_fmv orders by parallel_fmv desc", async () => {
    const { q, calls } = makeClient([])
    await fetchParallelPremiums(q, { ...baseOpts, sort: "parallel_fmv" })
    const order = calls.find((c) => c[0] === "order")!
    expect(order[1]).toEqual(["parallel_fmv", { ascending: false }])
  })

  it("sort=scarcity orders by parallel_circ ascending", async () => {
    const { q, calls } = makeClient([])
    await fetchParallelPremiums(q, { ...baseOpts, sort: "scarcity" })
    const order = calls.find((c) => c[0] === "order")!
    expect(order[1]).toEqual(["parallel_circ", { ascending: true }])
  })
})
