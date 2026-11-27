import { describe, it, expect } from "vitest"
import { fetchCandyPrintings, candyCardKey } from "@/lib/candy/edition-printings"

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

  // 2026-11-26 — player + set is not a card. A Play of the Day set holds several
  // different plays of one player; a 2023 ICON set holds the Core→Legendary ladder
  // AND separate "Past Insert" / "Signed Ball Insert" cards. The ladder listed all
  // of them as "Base" under copy promising a "/250 Base card and /15 Rainbow colours".
  it("⛔ a different card of the same player in the same set is NOT a printing", async () => {
    const { db } = fakeDb({ player_id: "p1", set_id: "potd", name: "Miguel Cabrera gets his 3000th Hit 4" }, [
      { id: "e1", external_id: "c:potd:mc-gets-his", name: "Miguel Cabrera gets his 3000th Hit 4", badges: null, circulation_count: 2479 },
      { id: "e2", external_id: "c:potd:mc-swipes", name: "Miguel Cabrera Swipes Third Base 7", badges: null, circulation_count: 142 },
    ])
    const r = await fetchCandyPrintings("e1", db)
    expect(r.ok).toBe(true)
    expect(r.printings).toHaveLength(0) // one printing → the section self-hides
  })

  it("⛔ a tier ladder is labelled by Candy's own rarity names, never 'Base' four times, and inserts drop out", async () => {
    const { db } = fakeDb({ player_id: "p1", set_id: "b2", name: "Kyle Tucker" }, [
      { id: "c", external_id: "kt-core", name: "Kyle Tucker", rarity_label: "Core", badges: null, circulation_count: 200 },
      { id: "u", external_id: "kt-unc", name: "Kyle Tucker", rarity_label: "Uncommon", badges: null, circulation_count: 100 },
      { id: "i", external_id: "kt-past", name: "Kyle Tucker- Past Insert", rarity_label: null, badges: null, circulation_count: 50 },
      { id: "r", external_id: "kt-rare", name: "Kyle Tucker", rarity_label: "Rare", badges: null, circulation_count: 50 },
    ])
    const r = await fetchCandyPrintings("c", db)
    expect(r.printings.map((p) => p.label)).toEqual(["Core", "Uncommon", "Rare"])
    expect(r.printings.some((p) => p.label === "Base")).toBe(false)
  })

  it("the 2026 Base card and its Rainbow colours stay one ladder (colour suffix stripped)", async () => {
    const { db } = fakeDb({ player_id: "p1", set_id: "s26", name: "Bobby Witt Jr." }, [
      { id: "b", external_id: "bobby-witt-jr", name: "Bobby Witt Jr.", badges: null, circulation_count: 250 },
      { id: "bl", external_id: "bobby-witt-jr-blue", name: "Bobby Witt Jr. - BLUE", badges: ["Rainbow (Blue)"], circulation_count: 15 },
    ])
    const r = await fetchCandyPrintings("b", db)
    expect(r.printings.map((p) => p.label)).toEqual(["Base", "Rainbow (Blue)"])
    expect(candyCardKey("Bobby Witt Jr. - PINK")).toBe(candyCardKey("Bobby Witt Jr."))
    expect(candyCardKey(null)).toBeNull()
  })
})
