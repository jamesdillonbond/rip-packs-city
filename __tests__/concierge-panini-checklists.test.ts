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

describe("readPaniniRookiesForConcierge (get_insight_board 'panini_rookies', 2026-11-23)", () => {
  function q(res: { data: unknown; error: unknown }, calls: string[]) {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "order", "limit"]) b[m] = (...a: unknown[]) => { calls.push(`${m}:${String(a[0])}`); return b }
    b.ilike = (c: string, v: string) => { calls.push(`ilike:${c}=${v}`); return b }
    b.then = (f: (v: unknown) => unknown) => Promise.resolve(res).then(f)
    return b
  }
  it("a failed read says the check failed — never 'no rookies'", async () => {
    const { readPaniniRookiesForConcierge } = await import("@/lib/concierge/panini-boards")
    const out = JSON.parse(await readPaniniRookiesForConcierge({ from: () => q({ data: null, error: { message: "x" } }, []) }, BASE, 10))
    expect(out.status).toBe("error")
  })
  it("narrows by sport, keeps a null FMV total null and links the player page", async () => {
    const { readPaniniRookiesForConcierge } = await import("@/lib/concierge/panini-boards")
    const calls: string[] = []
    const out = JSON.parse(await readPaniniRookiesForConcierge({ from: () => q({ data: [{ player_name: "Cooper Flagg", fmv_total_usd: null, rc_editions: 13 }], error: null }, calls) }, BASE, 10, "Basketball"))
    expect(calls).toContain("ilike:sport=Basketball")
    expect(out.rows[0].fmv_total_usd).toBeNull()
    expect(out.rows[0].player_url).toBe(`${BASE}/panini-blockchain/player/cooper-flagg`)
    expect(out.board_url).toBe(`${BASE}/insights/panini-squeeze?tab=rookies`)
  })
})

describe("Panini autographs + Scarcer for less on get_insight_board (2026-11-24)", () => {
  function q(res: { data: unknown; error: unknown }, calls: string[]) {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "order", "limit", "not"]) b[m] = (...a: unknown[]) => { calls.push(`${m}:${String(a[0])}`); return b }
    b.ilike = (c: string, v: string) => { calls.push(`ilike:${c}=${v}`); return b }
    b.then = (f: (v: unknown) => unknown) => Promise.resolve(res).then(f)
    return b
  }
  it("autographs: a failed read is a failed check, never 'no autographs'", async () => {
    const { readPaniniAutographsForConcierge } = await import("@/lib/concierge/panini-boards")
    const out = JSON.parse(await readPaniniAutographsForConcierge({ from: () => q({ data: null, error: { message: "x" } }, []) }, BASE, 10))
    expect(out.status).toBe("error")
    expect(out.message).toMatch(/never that Panini has no autograph cards/)
  })
  it("autographs: listed only, cheapest first, sport-narrowed, no premium field, says there is no unsigned pairing", async () => {
    const { readPaniniAutographsForConcierge } = await import("@/lib/concierge/panini-boards")
    const calls: string[] = []
    const out = JSON.parse(await readPaniniAutographsForConcierge({ from: () => q({ data: [{ external_id: "packcard-1_2_3_4", player_name: "AJ Griffin", low_ask: 12, median_90d: null }], error: null }, calls) }, BASE, 10, "Basketball"))
    expect(calls).toContain("not:low_ask")
    expect(calls).toContain("order:low_ask")
    expect(calls).toContain("ilike:sport=Basketball")
    expect(out.rows[0]).not.toHaveProperty("premium_x")
    expect(out.rows[0].median_90d_usd).toBeNull()
    expect(out.how_to_read).toMatch(/no autograph premium/i)
    expect(out.rows[0].edition_url).toBe(`${BASE}/panini-blockchain/edition/packcard-1_2_3_4`)
  })
  it("scarcer for less: biggest gap first, both printings linked, own sales carried, never a buy call", async () => {
    const { readPaniniScarcerForConcierge } = await import("@/lib/concierge/panini-boards")
    const calls: string[] = []
    const out = JSON.parse(await readPaniniScarcerForConcierge({ from: () => q({ data: [{ external_id: "packcard-a", common_external_id: "packcard-b", low_ask_usd: 275, own_sales_90d: 8, own_median_90d_usd: 280, common_median_90d_usd: 515, gap_usd: 240 }], error: null }, calls) }, BASE, 10))
    expect(calls[1]).toBe("order:gap_usd")
    expect(out.rows[0].own_median_90d_usd).toBe(280)
    expect(out.rows[0].more_common_url).toBe(`${BASE}/panini-blockchain/edition/packcard-b`)
    expect(out.how_to_read).toMatch(/NOT a buy call/)
    expect(out.board_url).toBe(`${BASE}/insights/panini-squeeze?tab=scarcer`)
  })
  it("both boards are wired into get_insight_board", () => {
    const route = readFileSync(join(process.cwd(), "app/api/support-chat/route.ts"), "utf8")
    expect(route).toContain('if (toolInput.board === "panini_autographs") return readPaniniAutographsForConcierge(')
    expect(route).toContain('if (toolInput.board === "panini_scarcer_for_less") return readPaniniScarcerForConcierge(')
    expect(route).toMatch(/"panini_rookies", "panini_autographs", "panini_scarcer_for_less", "candy_mlb"/)
  })
})
