import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readPinnacleChecklistForConcierge } from "@/lib/concierge/pinnacle-router"

// 2026-11-23: the concierge reads Disney Pinnacle's franchise / character checklists and its three new boards.
// Pins the honesty rules: a failed read is not "owns none"; an unindexed wallet makes ownership unknown; the
// never-sold asks stay outside the headline cost; a Pinnacle squeeze / pack-reality question is pointed at
// Pinnacle's own board, never answered with Top Shot rows.

const base = "https://www.rippackscity.com"
const db = (result: { data: unknown; error: unknown }, seen: unknown[] = []) => ({
  rpc: async (fn: string, args: unknown) => { seen.push({ fn, args }); return result },
})
const payload = {
  total: 3, owned: 1, missing: 2, wallet_cached: true,
  cost_at_ask_usd: 10, priced_at_ask: 1, cost_at_fmv_usd: 5, priced_at_fmv: 1,
  cost_ask_no_fmv_usd: 1_000_000, priced_ask_no_fmv: 0, unpriced: 0,
  pins: [
    { render_id: "A", name: "A", owned_count: 1, cost_usd: 3, cost_source: "ask" },
    { render_id: "B", name: "B", owned_count: 0, cost_usd: 10, cost_source: "ask" },
    { render_id: "C", name: "C", owned_count: 0, cost_usd: 5, cost_source: "fmv" },
  ],
}

describe("readPinnacleChecklistForConcierge", () => {
  it("calls the render-grain function with the kind and lists the most valuable missing pins", async () => {
    const seen: unknown[] = []
    const out = JSON.parse(await readPinnacleChecklistForConcierge(db({ data: payload, error: null }, seen), base, { kind: "franchise", name: "Star Wars™", wallet: "0xabc0000000000001", missingLimit: 5 }))
    expect(seen[0]).toEqual({ fn: "get_pinnacle_checklist", args: { p_kind: "franchise", p_name: "Star Wars™", p_wallet: "0xabc0000000000001" } })
    expect(out.status).toBe("ok")
    expect(out.owned).toBe(1)
    expect(out.most_valuable_missing.map((m: { pin: string }) => m.pin)).toEqual(["B", "C"])
    expect(out.page_url).toBe(`${base}/disney-pinnacle/team/star-wars`)
    expect(out.cost.never_sold_listed_usd).toBe(1_000_000)
    expect(out.how_to_read).toMatch(/never inside the headline/)
  })
  it("an unindexed wallet makes ownership unknown — never 'owns none'", async () => {
    const out = JSON.parse(await readPinnacleChecklistForConcierge(db({ data: { ...payload, wallet_cached: false, owned: 0, missing: 3 }, error: null }), base, { kind: "character", name: "Stitch", wallet: "0xabc0000000000001", missingLimit: 5 }))
    expect(out.wallet_indexed).toBe(false)
    expect(out.owned).toBeNull()
    expect(out.missing).toBeNull()
    expect(out.most_valuable_missing).toEqual([])
    expect(out.page_url).toBe(`${base}/disney-pinnacle/character/stitch`)
  })
  it("a failed read is an error that forbids 'owns none'; a subject with no pins is no_results", async () => {
    const bad = JSON.parse(await readPinnacleChecklistForConcierge(db({ data: null, error: { message: "timeout" } }), base, { kind: "franchise", name: "X", wallet: null, missingLimit: 5 }))
    expect(bad.status).toBe("error")
    expect(bad.message).toMatch(/never say the collector owns none/)
    const none = JSON.parse(await readPinnacleChecklistForConcierge(db({ data: null, error: null }), base, { kind: "franchise", name: "Nobody", wallet: null, missingLimit: 5 }))
    expect(none.status).toBe("no_results")
  })
})

describe("support-chat wiring", () => {
  const src = readFileSync(join(process.cwd(), "app/api/support-chat/route.ts"), "utf8")
  it("get_team_checklist answers Pinnacle from the checklist reader, not 'no teams'", () => {
    const start = src.indexOf('if (toolName === "get_team_checklist")')
    const end = src.indexOf('if (toolName === "get_team_intel")')
    const body = src.slice(start, end)
    expect(body).toContain("readPinnacleChecklistForConcierge(")
    expect(body).not.toContain("Disney Pinnacle has no teams")
  })
  it("get_insight_board knows the three Pinnacle boards and points Pinnacle squeeze / pack-reality at them", () => {
    for (const b of ['pinnacle_pack_reality: "pinnacle-pack-reality"', 'pinnacle_serial_premiums: "pinnacle-serial-premiums"', 'pinnacle_squeeze: "pinnacle-squeeze"']) {
      expect(src).toContain(b)
    }
    expect(src).toMatch(/onPinnacle && \(isSqueeze \|\| path === "pack-reality"\)/)
    expect(src).toMatch(/isMarket && onPinnacle \? "\?collection=disney-pinnacle"/)
  })
})
