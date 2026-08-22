import { describe, it, expect, beforeEach, vi } from "vitest"

// The Fast Break optimizer had three reads whose `error` was never destructured.
// supabase-js RETURNS errors rather than throwing, so each one degraded silently
// into a confident answer at HTTP 200:
//
//   nba_games       -> undefined -> `?? []` -> empty slate -> the projections block
//                      is skipped -> every eligible player is `continue`d for want
//                      of a projection -> `lineup: null`. BYTE-IDENTICAL to the
//                      legitimate "no games scheduled tonight" reply.
//   nba_players     -> undefined -> no name -> the listing lookup below is SKIPPED,
//                      so a name failure compounds into a listing claim.
//   cached_listings -> undefined -> `cheapestListing: null` -> the client renders
//                      "Not currently listed", a flat market claim about a named
//                      player, on a panel whose whole purpose is telling someone
//                      what to go buy.
//
// The last is the worst: it is a CONCLUSION, not an empty state, and it is
// actionable in the wrong direction — a user shopping for that player stops
// looking. "Not currently listed" is only earned by a query that came back empty.
//
// Every case below pairs the failure with its healthy twin, because the whole
// defect was that the two were indistinguishable. Asserting only the failure
// would pass against code that always reported failure.

const state: { tables: Record<string, any>; rpc: Record<string, any> } = { tables: {}, rpc: {} }

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "order", "gt", "gte", "lt", "limit"]) b[m] = () => b
    b.single = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    return b
  }
  const admin: any = {
    from: (t: string) => makeBuilder(t),
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { POST } from "@/app/api/fast-break/optimize/route"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const WALLET = "0xabcdef0123456789"

const req = () =>
  ({
    headers: new Headers(),
    nextUrl: new URL("https://t/api/fast-break/optimize"),
    json: async () => ({ walletAddr: WALLET, runId: RUN_ID }),
  }) as any

/** An active run plus one eligible player who is the top-ranked projection. */
function seedHealthyRun() {
  state.tables.fast_break_runs = {
    single: { data: { id: RUN_ID, lineup_size: 1, has_captain: false, is_active: true }, error: null },
  }
  state.rpc.get_fast_break_eligible_players = { data: [], error: null }
  state.tables.nba_games = {
    list: { data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL", tipoff_at: "t" }], error: null },
  }
  state.tables.nba_player_projections = {
    list: { data: [{ nba_player_id: "p4", game_id: "g1", proj_fp_dk: 50, proj_minutes: 30, injury_status: "ACTIVE" }], error: null },
  }
  state.tables.nba_players = {
    list: { data: [{ id: "p4", full_name: "Star Player", current_team_abbr: "GSW" }], error: null },
  }
  state.tables.cached_listings = { list: { data: [], error: null } }
}

beforeEach(() => {
  state.tables = {}
  state.rpc = {}
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("a failed slate read is not an empty slate", () => {
  it("500s when nba_games ERRORS", async () => {
    seedHealthyRun()
    state.tables.nba_games = { list: { data: null, error: { message: "statement timeout" } } }
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("games_lookup_failed")
  })

  it("still 200s with lineup null when there are GENUINELY no games", async () => {
    // The control. Without it, "500 on error" could be satisfied by 500ing always,
    // and the honest empty state — the one users see every off-season night — would
    // have been converted into an error page.
    seedHealthyRun()
    state.tables.nba_games = { list: { data: [], error: null } }
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).lineup).toBeNull()
  })
})

describe('"Not currently listed" is only earned by a query that came back empty', () => {
  it("marks the listing UNKNOWN when cached_listings errors", async () => {
    seedHealthyRun()
    state.tables.cached_listings = { list: { data: null, error: { message: "statement timeout" } } }
    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    const m = body.missingPlayers.find((p: any) => p.nbaPlayerId === "p4")
    expect(m, "the top-ranked unowned player should appear in the acquisition gap").toBeTruthy()
    expect(m.cheapestListing).toBeNull()
    expect(m.listingUnknown, "a failed listings read must not render as 'not listed'").toBe(true)
  })

  it("marks it UNKNOWN when the name read fails, because that skips the lookup", async () => {
    // The compounding case. No name means the listings query never runs at all,
    // so the player carries a market claim derived from a DIFFERENT failed read.
    seedHealthyRun()
    state.tables.nba_players = { list: { data: null, error: { message: "statement timeout" } } }
    const res = await POST(req())
    const m = (await res.json()).missingPlayers.find((p: any) => p.nbaPlayerId === "p4")
    expect(m.fullName).toBeNull()
    expect(m.listingUnknown).toBe(true)
  })

  it("leaves it KNOWN when we looked and the player genuinely has nothing for sale", async () => {
    // The control that keeps the flag meaningful: if listingUnknown were always
    // true, the client would never show the real claim and the fix would have
    // traded one dishonest state for another.
    seedHealthyRun()
    const res = await POST(req())
    const m = (await res.json()).missingPlayers.find((p: any) => p.nbaPlayerId === "p4")
    expect(m.cheapestListing).toBeNull()
    expect(m.listingUnknown).toBe(false)
  })

  it("leaves it KNOWN when a real listing is found", async () => {
    seedHealthyRun()
    state.tables.cached_listings = {
      list: { data: [{ moment_id: "m4", ask_price: 12, buy_url: "http://x" }], error: null },
    }
    const res = await POST(req())
    const m = (await res.json()).missingPlayers.find((p: any) => p.nbaPlayerId === "p4")
    expect(m.cheapestListing?.momentId).toBe("m4")
    expect(m.listingUnknown).toBe(false)
  })
})
