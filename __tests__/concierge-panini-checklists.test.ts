import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { summarizePaniniChecklist, readPaniniPlayerChecklistForConcierge, readPaniniTeamForConcierge, readPaniniChecklistToolForConcierge } from "@/lib/concierge/panini-boards"

// 2026-11-23 Panini parity pass 2: the concierge reads the Panini player + franchise checklists the pages render.
// Pins the three honest states: a failed read is UNKNOWN (never "owns none"), a username RPC has never seen is
// unknown (never "owns none"), a "seen" read is a lower bound — and a typed player name reaches the page's slug.

const BASE = "https://www.rippackscity.com"
const card = (id: string, owned: number | null, cost: number | null, src: string | null) => ({
  external_id: id, name: "x", player_name: "Damian Lillard", set_name: "Base", parallel: "Base", product_name: "P",
  tier: "COMMON", mint_cap: 99, thumbnail_url: null, fmv_usd: cost, low_ask_usd: null, cost_usd: cost, cost_source: src, owned_count: owned,
})
const ok = {
  player: "Damian Lillard", username: "ywrr", source: "seen", username_seen: true, profile_read_at: null,
  total: 3, owned: 1, missing: 2, cost_at_ask_usd: 10, priced_at_ask: 1, cost_at_fmv_usd: 0, priced_at_fmv: 0,
  cost_ask_no_fmv_usd: 0, priced_ask_no_fmv: 0, unpriced: 1,
  cards: [card("a", 1, 5, "ask"), card("b", 0, 10, "ask"), card("c", 0, null, null)],
}

describe("summarizePaniniChecklist", () => {
  it("a failed read is unknown — never 'owns none'", () => {
    const out = summarizePaniniChecklist({ data: null, error: { message: "timeout" } }, BASE, 15)
    expect(out.status).toBe("error")
    expect(String(out.message)).toMatch(/unknown/)
    expect(out).not.toHaveProperty("owned")
  })
  it("a username RPC has never seen is unknown, not zero", () => {
    const out = summarizePaniniChecklist({ data: { ...ok, username_seen: false, owned: 0, missing: 3 }, error: null }, BASE, 15)
    expect(out.status).toBe("username_not_seen")
    expect(out).not.toHaveProperty("owned")
    expect(String(out.message)).toContain("unknown, not zero")
  })
  it("calls a marketplace-seen read a lower bound and lists the missing cards, priciest first", () => {
    const out = summarizePaniniChecklist({ data: ok, error: null }, BASE, 15)
    expect(out.status).toBe("ok")
    expect(String(out.ownership_note)).toContain("LOWER BOUND")
    const miss = out.most_valuable_missing as { cost_usd: number | null; edition_url: string }[]
    expect(miss.map((m) => m.cost_usd)).toEqual([10, null])
    expect(miss[0].edition_url).toBe(`${BASE}/panini-blockchain/edition/b`)
    expect(String(out.how_to_read)).toContain("NOT in it")
  })
})

function db(rpc: (fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpc(fn, args) },
  }
}

describe("readPaniniPlayerChecklistForConcierge", () => {
  it("resolves the typed name to the page slug (accents folded) and passes the username", async () => {
    const d = db(() => ({ data: ok, error: null }))
    const out = JSON.parse(await readPaniniPlayerChecklistForConcierge(d, BASE, "Luka Dončić", "ywrr", 10))
    expect(d.calls[0]).toEqual({ fn: "get_panini_player_checklist", args: { p_player_slug: "luka-doncic", p_username: "ywrr" } })
    expect(out.page_url).toBe(`${BASE}/panini-blockchain/player/luka-doncic`)
    expect(out.status).toBe("ok")
  })
  it("an unknown player is no_results — never an empty checklist", async () => {
    const out = JSON.parse(await readPaniniPlayerChecklistForConcierge(db(() => ({ data: null, error: null })), BASE, "Nobody Atall", null, 10))
    expect(out.status).toBe("no_results")
  })
  it("a thrown read says the check failed", async () => {
    const out = JSON.parse(await readPaniniPlayerChecklistForConcierge({ rpc: async () => { throw new Error("x") } }, BASE, "Damian Lillard", null, 10))
    expect(out.status).toBe("error")
  })
})

describe("readPaniniTeamForConcierge with a username", () => {
  function teamDb() {
    const calls: string[] = []
    const q = (res: { data: unknown; error: unknown }) => {
      const b: Record<string, unknown> = {}
      for (const m of ["select", "in", "eq", "limit"]) b[m] = () => b
      b.then = (f: (v: unknown) => unknown) => Promise.resolve(res).then(f)
      return b
    }
    return {
      calls,
      from: () => q({ data: [{ league: "NBA", slug: "blazers", team_name: "Portland Trail Blazers" }], error: null }),
      rpc: async (fn: string) => {
        calls.push(fn)
        if (fn === "get_panini_franchise_panel") return { data: { edition_count: 3, player_count: 1, fmv_total_usd: 15 }, error: null }
        if (fn === "get_panini_franchise_editions") return { data: [], error: null }
        return { data: { ...ok, player: undefined, franchise_key: "NBA:blazers" }, error: null }
      },
    }
  }
  it("attaches the scored franchise checklist only when a username is given", async () => {
    const withU = teamDb()
    const a = JSON.parse(await readPaniniTeamForConcierge(withU, BASE, "Blazers", 10, "ywrr"))
    expect(withU.calls).toContain("get_panini_franchise_checklist")
    expect(a.checklist.status).toBe("ok")
    const noU = teamDb()
    const b = JSON.parse(await readPaniniTeamForConcierge(noU, BASE, "Blazers", 10))
    expect(noU.calls).not.toContain("get_panini_franchise_checklist")
    expect(b).not.toHaveProperty("checklist")
  })
})

describe("readPaniniChecklistToolForConcierge", () => {
  it("refuses a malformed username instead of looking it up", async () => {
    const d = db(() => ({ data: ok, error: null }))
    const out = JSON.parse(await readPaniniChecklistToolForConcierge(d, BASE, "Damian Lillard", { kind: "player", username: "0x94860edbafac862e!" }))
    expect(out.status).toBe("error")
    expect(d.calls).toHaveLength(0)
  })
  it("kind player reads the player checklist with the lowercased username", async () => {
    const d = db(() => ({ data: ok, error: null }))
    await readPaniniChecklistToolForConcierge(d, BASE, "Damian Lillard", { kind: "player", username: "@YWRR" })
    expect(d.calls[0]).toEqual({ fn: "get_panini_player_checklist", args: { p_player_slug: "damian-lillard", p_username: "ywrr" } })
  })
})

describe("support-chat wiring", () => {
  const route = readFileSync(join(process.cwd(), "app/api/support-chat/route.ts"), "utf8")
  it("get_team_checklist routes Panini usernames and kind player to the checklist readers", () => {
    expect(route).toContain('if (slug === "panini-blockchain") return readPaniniChecklistToolForConcierge(supabase, base, teamIn, toolInput)')
    expect(route).toMatch(/enum: \["franchise", "character", "player"\]/)
  })
  it("the prompt no longer says Panini has no player checklist", () => {
    expect(route).not.toContain("Golazos and Candy MLB — not on Panini")
  })
})
