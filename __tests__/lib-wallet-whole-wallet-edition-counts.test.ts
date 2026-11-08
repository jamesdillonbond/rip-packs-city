import { describe, it, expect } from "vitest"
import { wholeWalletEditionCounts } from "@/lib/wallet/whole-wallet-edition-counts"

// "You hold N" over the whole wallet (2026-11-08). The helper reads the page's
// edition keys from wallet_moments_cache, then every cached moment of those keys,
// and counts only moments the chain still says the wallet owns.

type Row = { moment_id: string; edition_key: string | null }

function fakeDb(rows: Row[], opts: { failKeys?: boolean; failCount?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    from: (_t: string) => {
      const q: any = { _in: null as null | { col: string; vals: string[] }, _range: [0, 999] }
      q.select = () => q
      q.eq = () => q
      q.order = () => q
      q.in = (col: string, vals: string[]) => {
        q._in = { col, vals }
        return q
      }
      q.range = (a: number, b: number) => {
        q._range = [a, b]
        return q
      }
      q.then = (resolve: (v: unknown) => void) => {
        const col = q._in?.col
        calls.push(String(col))
        if (col === "moment_id") {
          if (opts.failKeys) return resolve({ data: null, error: { message: "boom" } })
          return resolve({ data: rows.filter((r) => q._in.vals.includes(r.moment_id)), error: null })
        }
        if (opts.failCount) return resolve({ data: null, error: { message: "timeout" } })
        const all = rows
          .filter((r) => r.edition_key && q._in.vals.includes(r.edition_key))
          .sort((x, y) => (x.moment_id < y.moment_id ? -1 : 1))
        return resolve({ data: all.slice(q._range[0], q._range[1] + 1), error: null })
      }
      return q
    },
  }
}

describe("wholeWalletEditionCounts", () => {
  const rows: Row[] = [
    { moment_id: "1", edition_key: "3:45" }, // on the page
    { moment_id: "2", edition_key: "3:45" }, // another page
    { moment_id: "3", edition_key: "3:45" }, // another page
    { moment_id: "4", edition_key: "3:45" }, // SOLD: still cached, not in owned ids
    { moment_id: "5", edition_key: "3:45::2" }, // a parallel: its own key
    { moment_id: "6", edition_key: "3:45::2" },
  ]
  const owned = [1, 2, 3, 5, 6] // chain ids (numbers, as the route has them)

  it("counts every OWNED copy of the page moment's edition, across pages", async () => {
    const out = await wholeWalletEditionCounts(fakeDb(rows), "0xabc", "c", ["1", "5"], owned)
    expect(out?.get("1")).toBe(3)
    expect(out?.get("5")).toBe(2)
  })

  it("⚠ a cached moment the wallet no longer owns is not counted", async () => {
    const out = await wholeWalletEditionCounts(fakeDb(rows), "0xabc", "c", ["1"], owned)
    expect(out?.get("1")).toBe(3) // not 4
  })

  it("a page moment the cache has not walked gets no entry (caller keeps its page count)", async () => {
    const out = await wholeWalletEditionCounts(fakeDb(rows), "0xabc", "c", ["99"], owned)
    expect(out?.has("99")).toBe(false)
  })

  it("⚠ a failed read is null, never a count", async () => {
    expect(await wholeWalletEditionCounts(fakeDb(rows, { failKeys: true }), "0xabc", "c", ["1"], owned)).toBeNull()
    expect(await wholeWalletEditionCounts(fakeDb(rows, { failCount: true }), "0xabc", "c", ["1"], owned)).toBeNull()
  })

  it("pages past PostgREST's 1,000-row cap", async () => {
    const many: Row[] = Array.from({ length: 2500 }, (_, i) => ({ moment_id: String(10000 + i), edition_key: "9:9" }))
    const ownedMany = many.map((r) => Number(r.moment_id))
    const db = fakeDb(many)
    const out = await wholeWalletEditionCounts(db, "0xabc", "c", ["10000"], ownedMany)
    expect(out?.get("10000")).toBe(2500)
    expect(db.calls.filter((c) => c === "edition_key").length).toBe(3)
  })

  it("an empty page reads nothing", async () => {
    const db = fakeDb(rows)
    expect((await wholeWalletEditionCounts(db, "0xabc", "c", [], owned))?.size).toBe(0)
    expect(db.calls).toEqual([])
  })
})
