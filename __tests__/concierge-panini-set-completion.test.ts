import { describe, it, expect } from "vitest"
import { readPaniniSetCompletionForConcierge } from "@/lib/concierge/panini-boards"

/**
 * get_set_completion_cost / get_cheapest_sets_to_complete on a Panini page (2026-10-26).
 * The ranking is filtered and ordered SERVER-side (one collector has 2,712 set rows, past
 * PostgREST's 1,000-row clamp), costs with an unpriced missing edition are FLOORS, and a
 * failed read is never "no sets in progress".
 */

type Call = { m: string; a: unknown[] }
function db(result: { data: unknown; error: unknown }) {
  const calls: Call[] = []
  const chain: any = {}
  for (const m of ["gt", "ilike", "order", "range"]) {
    chain[m] = (...a: unknown[]) => { calls.push({ m, a }); return chain }
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
  return {
    calls,
    rpc: (name: string, args: unknown) => { calls.push({ m: "rpc", a: [name, args] }); return chain },
  }
}
const ROW = {
  product_set_id: 2332, product_name: "2026 Panini NFT Prizm World Cup", sport: "Soccer", set_name: "Base Prizms Gold",
  editions_seen: 40, players_seen: 40, owned: 38, missing: 2, missing_asked: 1, missing_unasked: 1,
  cost_usd: 120, max_missing_ask_usd: 120, owner_last_seen_at: "2026-10-26T10:00:00Z", fmv_confidence: "HIGH",
}

describe("readPaniniSetCompletionForConcierge", () => {
  it("filters to sets in progress and orders server-side: fully priced first, then cheapest", async () => {
    const d = db({ data: [ROW], error: null })
    const r = JSON.parse(await readPaniniSetCompletionForConcierge(d, "https://x", { username: "Spinotron", limit: 3 }))
    expect(r.status).toBe("ok")
    const ms = d.calls.map((c) => c.m)
    expect(d.calls[0].a).toEqual(["panini_set_progress_all", { p_username: "Spinotron" }])
    expect(d.calls.filter((c) => c.m === "gt").map((c) => c.a[0])).toEqual(["owned", "missing"])
    expect(d.calls.filter((c) => c.m === "order").map((c) => c.a[0])).toEqual(["missing_unasked", "cost_usd", "missing", "product_set_id", "set_name"])
    expect(d.calls.find((c) => c.m === "range")!.a).toEqual([0, 2])
    expect(ms).not.toContain("ilike")
  })
  it("a cost with a missing edition that has no ask is a FLOOR, and links the Sets tab for that product and username", async () => {
    const d = db({ data: [ROW], error: null })
    const r = JSON.parse(await readPaniniSetCompletionForConcierge(d, "https://x", { username: "spinotron" }))
    expect(r.sets[0].cost_is_floor).toBe(true)
    expect(r.sets[0].missing_without_ask).toBe(1)
    expect(r.sets[0].sets_tab_url).toBe("https://x/panini-blockchain/sets?username=spinotron&product=2332")
    expect(String(r.how_to_read)).toMatch(/floor/)
    expect(JSON.stringify(r)).not.toMatch(/HIGH|confidence/)
  })
  it("a named set is matched by set name, with LIKE wildcards in the input escaped", async () => {
    const d = db({ data: [ROW], error: null })
    await readPaniniSetCompletionForConcierge(d, "https://x", { username: "spinotron", setName: "100%_Gold" })
    expect(d.calls.find((c) => c.m === "ilike")!.a).toEqual(["set_name", "%100\\%\\_Gold%"])
  })
  it("a failed read is an error that forbids 'no sets in progress'; an empty read says RPC hasn't SEEN one", async () => {
    let r = JSON.parse(await readPaniniSetCompletionForConcierge(db({ data: null, error: { message: "timeout" } }), "https://x", { username: "spinotron" }))
    expect(r.status).toBe("error")
    expect(String(r.message)).toMatch(/never say this collector has no sets in progress/)
    r = JSON.parse(await readPaniniSetCompletionForConcierge(db({ data: [], error: null }), "https://x", { username: "spinotron" }))
    expect(r.status).toBe("no_results")
    expect(String(r.message)).toMatch(/does NOT mean they own nothing/)
  })
  it("a malformed username is refused without a read", async () => {
    const d = db({ data: [], error: null })
    const r = JSON.parse(await readPaniniSetCompletionForConcierge(d, "https://x", { username: "0x0b2a3299cc857e29<>" }))
    expect(r.status).toBe("bad_username")
    expect(d.calls).toHaveLength(0)
  })
})
