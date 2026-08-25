import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/teams.
//
// GET is PUBLIC and ownerKey-driven (holdings are public on a showcase), so its
// guards are param-based. POST is AUTH-GATED as of the 2026-07-29 IDOR fix: the
// write target comes from the SESSION, and the body `ownerKey` is accepted only
// when it resolves to the caller. Before that fix any signed-in user could
// replace-all-write anyone's favorite teams via the service-role client.
//
// Pins GET 400/empty/mapped/500, the POST body 400s, and — the security contract
// itself — POST 401 unauthenticated + POST 403 cross-user. Those two had NO
// coverage, which is how the route hardening landed while this file still
// asserted "no session gate" and reddened CI for every concurrent session.

const state: { single: any; result: any } = {
  single: { data: null, error: null },
  result: { data: [], error: null },
}

// requireUser() returns the user or THROWS a 401 Response; the route catches it
// and returns it verbatim. Read lazily inside the mock so it tracks per-test
// mutation (same deferred-access pattern as `state` above).
const session: { user: { id: string } | null } = { user: { id: "u1" } }
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!session.user) {
      throw new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    }
    return session.user
  },
}))

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, insert: () => b, delete: () => b, eq: () => b,
      ilike: () => b, order: () => b,
      maybeSingle: async () => state.single,
      single: async () => state.single,
      then: (resolve: any) => resolve(state.result),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.result }
  return { supabase: client, supabaseAdmin: client }
})

const awardPoints = vi.fn(async () => undefined)
vi.mock("@/lib/rewards", () => ({ awardPoints: (...a: any[]) => (awardPoints as any)(...a) }))

import { GET, POST } from "@/app/api/profile/teams/route"

const req = (url: string, body?: any, throws = false) =>
  ({
    nextUrl: new URL(url),
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.single = { data: null, error: null }
  state.result = { data: [], error: null }
  session.user = { id: "u1" } // signed in as u1 unless a test says otherwise
  awardPoints.mockClear()
})

const teamRow = {
  league: "NBA",
  team_slug: "portland-trail-blazers",
  is_primary: true,
  teams_master: { team_name: "Trail Blazers", abbreviation: "POR", primary_color: "#111" },
}

describe("/api/profile/teams", () => {
  it("GET 400s without ownerKey", async () => {
    const res = await GET(req("https://t/api/profile/teams"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("GET returns empty teams for an unknown owner", async () => {
    state.single = { data: null, error: null } // resolveUserId → null
    const res = await GET(req("https://t/api/profile/teams?ownerKey=nobody"))
    expect(res.status).toBe(200)
    expect((await res.json()).teams).toEqual([])
  })

  // HONESTY CANON, and CLAUDE.md names this exact rendering as an instance of
  // the class: *"Follow a team to build your hub" to someone who follows six.*
  // `resolveUserId` DID look at its error and log it, then collapsed it onto
  // `null` — which this GET spells `{ teams: [] }` at 200. Catching an error is
  // not reporting it. The case directly above is the genuine-absence control.
  it("GET does not answer an empty team set when the owner lookup errored", async () => {
    state.single = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req("https://t/api/profile/teams?ownerKey=trevor"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.teams).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("POST 400s on invalid JSON body", async () => {
    const res = await POST(req("https://t/api/profile/teams", undefined, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("POST 400s without ownerKey", async () => {
    expect((await POST(req("https://t/api/profile/teams", { teams: [] }))).status).toBe(400)
  })

  it("POST 400s when teams is not an array", async () => {
    const res = await POST(req("https://t/api/profile/teams", { ownerKey: "trevor", teams: "no" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("teams must be an array")
  })

  it("GET returns the mapped team set for a known owner", async () => {
    state.single = { data: { user_id: "u1" }, error: null } // resolveUserId → u1
    state.result = { data: [teamRow], error: null }
    const res = await GET(req("https://t/api/profile/teams?ownerKey=trevor"))
    expect(res.status).toBe(200)
    const { teams } = await res.json()
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ league: "NBA", team_name: "Trail Blazers", abbreviation: "POR", is_primary: true })
  })

  it("GET 500s when the team select errors", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.result = { data: null, error: { message: "db down" } }
    expect((await GET(req("https://t/api/profile/teams?ownerKey=trevor"))).status).toBe(500)
  })

  it("POST 400s on an invalid league", async () => {
    const res = await POST(req("https://t/api/profile/teams", { ownerKey: "t", teams: [{ league: "MLB", team_slug: "x" }] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("invalid league")
  })

  it("POST 400s on a non-object team row", async () => {
    const res = await POST(req("https://t/api/profile/teams", { ownerKey: "t", teams: [null] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("team rows must be objects")
  })

  it("POST 400s on a duplicate league", async () => {
    const res = await POST(
      req("https://t/api/profile/teams", {
        ownerKey: "t",
        teams: [
          { league: "NBA", team_slug: "a" },
          { league: "NBA", team_slug: "b" },
        ],
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("duplicate league")
  })

  it("POST 400s when more than one team is primary", async () => {
    const res = await POST(
      req("https://t/api/profile/teams", {
        ownerKey: "t",
        teams: [
          { league: "NBA", team_slug: "a", is_primary: true },
          { league: "NFL", team_slug: "b", is_primary: true },
        ],
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("at most one team")
  })

  it("POST 404s when the owner cannot be resolved", async () => {
    state.single = { data: null, error: null } // resolveUserId → null
    const res = await POST(req("https://t/api/profile/teams", { ownerKey: "ghost", teams: [] }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("user not found")
  })

  // ── the IDOR contract (2026-07-29) ──────────────────────────────────────────
  it("POST 401s when unauthenticated, before touching the body or the DB", async () => {
    session.user = null
    state.single = { data: { user_id: "u1" }, error: null }
    const res = await POST(
      req("https://t/api/profile/teams", {
        ownerKey: "trevor",
        teams: [{ league: "NBA", team_slug: "portland-trail-blazers" }],
      })
    )
    expect(res.status).toBe(401)
    expect(awardPoints).not.toHaveBeenCalled()
  })

  it("POST 403s when ownerKey resolves to a DIFFERENT user (the IDOR that was closed)", async () => {
    session.user = { id: "attacker" }
    state.single = { data: { user_id: "victim" }, error: null } // ownerKey → someone else
    const res = await POST(
      req("https://t/api/profile/teams", {
        ownerKey: "victim-username",
        teams: [{ league: "NBA", team_slug: "portland-trail-blazers" }],
      })
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("forbidden")
    expect(awardPoints).not.toHaveBeenCalled()
  })

  it("POST replaces the set, reselects, and awards set_favorite_team", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.result = { data: [teamRow], error: null } // delete/insert ok + reselect returns the saved row
    const res = await POST(
      req("https://t/api/profile/teams", {
        ownerKey: "trevor",
        teams: [{ league: "NBA", team_slug: "portland-trail-blazers", is_primary: true }],
      })
    )
    expect(res.status).toBe(200)
    const { teams } = await res.json()
    expect(teams[0]).toMatchObject({ team_name: "Trail Blazers" })
    expect(awardPoints).toHaveBeenCalledWith("u1", "set_favorite_team")
  })

  it("POST with an all-empty selection deletes-all and does NOT award points", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.result = { data: [], error: null } // nothing left after the replace
    const res = await POST(
      req("https://t/api/profile/teams", {
        ownerKey: "trevor",
        teams: [{ league: "NBA", team_slug: "" }], // empty slug = cleared, skipped
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).teams).toEqual([])
    expect(awardPoints).not.toHaveBeenCalled()
  })
})
