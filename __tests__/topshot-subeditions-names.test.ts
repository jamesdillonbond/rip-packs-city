// lib/topshot-subeditions.ts (2026-10-28) — the one in-code source of Top Shot parallel names, read from the
// chain-backed public.topshot_subeditions. Pinned: a failed or empty read is a FAILURE (callers then write no
// name), and an id the list lacks is null — never an invented "Parallel N".
import { describe, it, expect } from "vitest"
import { loadTopshotSubeditionNames, subeditionName } from "@/lib/topshot-subeditions"

const db = (res: { data: unknown; error: unknown }) => ({
  from: (t: string) => ({ select: async () => (t === "topshot_subeditions" ? res : { data: null, error: { message: "wrong table" } }) }),
})

describe("loadTopshotSubeditionNames", () => {
  it("reads id → name from topshot_subeditions", async () => {
    const r = await loadTopshotSubeditionNames(db({ data: [{ subedition_id: 23, name: "Animated" }, { subedition_id: 24, name: "Illustrated" }], error: null }))
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.names.entries()]).toEqual([[23, "Animated"], [24, "Illustrated"]])
  })
  it("an error, a throw or zero rows is a failed read — never an empty success", async () => {
    expect((await loadTopshotSubeditionNames(db({ data: null, error: { message: "boom" } }))).ok).toBe(false)
    expect((await loadTopshotSubeditionNames(db({ data: [], error: null }))).ok).toBe(false)
    expect((await loadTopshotSubeditionNames({ from: () => { throw new Error("x") } })).ok).toBe(false)
  })
})

describe("subeditionName", () => {
  it("is the known name, or null — never 'Parallel N'", () => {
    const names = new Map([[23, "Animated"]])
    expect(subeditionName(names, 23)).toBe("Animated")
    expect(subeditionName(names, 25)).toBeNull()
    expect(subeditionName(null, 23)).toBeNull()
  })
})
