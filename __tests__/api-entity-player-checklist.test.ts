import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The PLAYER checklist (beta feedback 11691, webz_80 2026-10-27; shipped 2026-10-30):
 * /api/entity/team-checklist, -progress and -full-editions take `entity=player` and
 * call the player RPC pair (get_player_checklist / get_player_checklist_progress,
 * migration 20261031044056) with `p_player_slug`. Absent → the team pair, exactly
 * as before (every pre-10-30 caller). Unknown → 400 before any RPC, never the team
 * checklist under a player's slug (the substitution shape).
 */

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: fn.endsWith("_progress") ? { total: 0, wallet_cached: false } : [], error: null })
    },
    from: () => ({ select: () => ({ eq: () => ({ like: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }) }),
  },
}))

import { GET as checklistGET } from "@/app/api/entity/team-checklist/route"
import { GET as progressGET } from "@/app/api/entity/team-checklist-progress/route"
import { GET as fullGET } from "@/app/api/entity/team-checklist-full-editions/route"
import { checklistRpcs, parseChecklistEntity } from "@/lib/entity/checklist-entity"

const req = (route: string, q: string) => new Request(`https://t/api/entity/${route}?${q}`)
const WALLET = "0x28befde9db19134d"

beforeEach(() => { rpcCalls.length = 0 })

describe("lib/entity/checklist-entity", () => {
  it("absent = team; player = player; anything else = null", () => {
    expect(parseChecklistEntity(null)).toBe("team")
    expect(parseChecklistEntity("")).toBe("team")
    expect(parseChecklistEntity("player")).toBe("player")
    expect(parseChecklistEntity("set")).toBeNull()
    expect(parseChecklistEntity("__proto__")).toBeNull()
  })
  it("names the RPC pair and the slug argument per subject", () => {
    expect(checklistRpcs("team")).toEqual({ rows: "get_team_checklist", progress: "get_team_checklist_progress", slugArg: "p_team_slug" })
    expect(checklistRpcs("player")).toEqual({ rows: "get_player_checklist", progress: "get_player_checklist_progress", slugArg: "p_player_slug" })
  })
})

for (const [name, GET, route] of [
  ["team-checklist", checklistGET, "team-checklist"],
  ["team-checklist-progress", progressGET, "team-checklist-progress"],
] as const) {
  describe(`GET /api/entity/${name} entity=`, () => {
    it("entity=player calls the player RPC with p_player_slug (and no p_team_slug)", async () => {
      const r = await GET(req(route, `collection=nba-top-shot&slug=nikola-jokic&entity=player&wallet=${WALLET}&scope=series_8`))
      expect(r.status).toBe(200)
      expect(rpcCalls).toHaveLength(1)
      expect(rpcCalls[0].fn).toBe(route === "team-checklist" ? "get_player_checklist" : "get_player_checklist_progress")
      expect(rpcCalls[0].args.p_player_slug).toBe("nikola-jokic")
      expect(rpcCalls[0].args).not.toHaveProperty("p_team_slug")
      expect(rpcCalls[0].args.p_wallet).toBe(WALLET)
      expect(rpcCalls[0].args.p_scope).toBe("series_8")
    })
    it("no entity is the team checklist, unchanged", async () => {
      const r = await GET(req(route, `collection=nba-top-shot&slug=denver-nuggets`))
      expect(r.status).toBe(200)
      expect(rpcCalls[0].fn).toBe(route === "team-checklist" ? "get_team_checklist" : "get_team_checklist_progress")
      expect(rpcCalls[0].args.p_team_slug).toBe("denver-nuggets")
      expect(rpcCalls[0].args).not.toHaveProperty("p_player_slug")
    })
    it("an unknown entity is a 400 that reads nothing", async () => {
      const r = await GET(req(route, `collection=nba-top-shot&slug=denver-nuggets&entity=set`))
      expect(r.status).toBe(400)
      expect(rpcCalls).toHaveLength(0)
    })
  })
}

describe("GET /api/entity/team-checklist-full-editions entity=player", () => {
  it("walks the PLAYER pair for the header and every page", async () => {
    const r = await fullGET(req("team-checklist-full-editions", `collection=nba-top-shot&slug=nikola-jokic&entity=player`))
    expect(r.status).toBe(200)
    expect(rpcCalls.map((c) => c.fn)).toEqual(["get_player_checklist_progress", "get_player_checklist"])
    for (const c of rpcCalls) {
      expect(c.args.p_player_slug).toBe("nikola-jokic")
      expect(c.args).not.toHaveProperty("p_team_slug")
    }
  })
  it("an unknown entity is a 400 before the progress read", async () => {
    const r = await fullGET(req("team-checklist-full-editions", `collection=nba-top-shot&slug=nikola-jokic&entity=nope`))
    expect(r.status).toBe(400)
    expect(rpcCalls).toHaveLength(0)
  })
})
