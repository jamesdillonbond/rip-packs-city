import { describe, it, expect } from "vitest"
import { fetchCandyPrintings } from "@/lib/candy/edition-printings"

// 2026-11-08 — Candy now catalogues several sets (Base, All-Star, Gold Series,
// Quest rewards). A player's All-Star ICON is a different card, not a parallel
// printing of their Base ICON, so the edition page's ladder reads siblings INSIDE
// the edition's own set.

function fakeDb(self: Record<string, unknown>, sibs: Array<Record<string, unknown>>) {
  const eqCalls: Array<[string, unknown]> = []
  const q = (rows: unknown[]) => {
    const chain: any = {
      select: () => chain,
      eq: (col: string, v: unknown) => { eqCalls.push([col, v]); return chain },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (f: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(f),
    }
    return chain
  }
  let n = 0
  const db = { from: (t: string) => (t === "editions" ? q(n++ === 0 ? [self] : sibs) : q([])) }
  return { db, eqCalls }
}

describe("fetchCandyPrintings", () => {
  it("reads siblings within the edition's own set", async () => {
    const { db, eqCalls } = fakeDb({ player_id: "p1", set_id: "set-asg" }, [
      { id: "e1", external_id: "asg26:x-rare", badges: null, circulation_count: 50 },
      { id: "e2", external_id: "asg26:x-core", badges: null, circulation_count: 225 },
    ])
    const r = await fetchCandyPrintings("e1", db)
    expect(r.ok).toBe(true)
    expect(eqCalls).toContainEqual(["set_id", "set-asg"])
  })

  it("an edition with no set_id still gets its ladder (no impossible set filter)", async () => {
    const { db, eqCalls } = fakeDb({ player_id: "p1", set_id: null }, [
      { id: "e1", external_id: "a", badges: null, circulation_count: 250 },
      { id: "e2", external_id: "a-pink", badges: ["Rainbow (Pink)"], circulation_count: 15 },
    ])
    const r = await fetchCandyPrintings("e1", db)
    expect(r.printings).toHaveLength(2)
    expect(eqCalls.some(([c]) => c === "set_id")).toBe(false)
  })
})
