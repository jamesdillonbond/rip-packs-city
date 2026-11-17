import { describe, it, expect } from "vitest"
import { fetchPaniniEditionAskHistory } from "@/lib/panini/edition-extras"

/** fetchPaniniEditionAskHistory: a failed read is null (never an empty history); a NULL or zero
 *  ask is "no confirmed ask", never a $0 price. */

function fakeDb(res: { data?: unknown; error?: unknown }, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(table)
      const q: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok)
          return () => q
        },
      })
      return q
    },
  }
}

describe("fetchPaniniEditionAskHistory", () => {
  it("reads the lane and keeps a null / zero ask as null", async () => {
    const seen: string[] = []
    const r = await fetchPaniniEditionAskHistory("e1", fakeDb({ data: [
      { day: "2026-10-25", low_ask_usd: null },
      { day: "2026-10-24", low_ask_usd: "0" },
      { day: "2026-10-21", low_ask_usd: "12.5" },
    ], error: null }, seen))
    expect(seen).toEqual(["panini_edition_ask_daily"])
    expect(r.rows).toEqual([
      { day: "2026-10-25", lowAskUsd: null },
      { day: "2026-10-24", lowAskUsd: null },
      { day: "2026-10-21", lowAskUsd: 12.5 },
    ])
  })
  it("an ok read with no rows is an empty history, not a failure", async () => {
    expect((await fetchPaniniEditionAskHistory("e1", fakeDb({ data: [], error: null }))).rows).toEqual([])
  })
  it("an error or a throw is a failed read (null)", async () => {
    expect((await fetchPaniniEditionAskHistory("e1", fakeDb({ data: null, error: { message: "x" } }))).rows).toBeNull()
    const throwing = { from: () => { throw new Error("boom") } }
    expect((await fetchPaniniEditionAskHistory("e1", throwing)).rows).toBeNull()
  })
})
