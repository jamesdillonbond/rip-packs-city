import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchFanTeams,
  fetchBoundWallet,
  fetchTeamCard,
  type FanTeam,
} from "@/lib/fan-teams/fetchers"

// The reads behind /my-teams.
//
// ⚠ TWO OF THEM TURNED A FAILED READ INTO A FALSE CLAIM ABOUT THE READER'S OWN
// ACCOUNT — the worst version of this class, because the reader is the one
// person who knows the claim is wrong and has no way to tell that we do too.
// And they sat behind sign-in, which is precisely why no sweep had reached
// them: the anon driver-message guard derives its file set from `isPublicPath`,
// so everything past the auth wall is outside it BY CONSTRUCTION.

const TEAM: FanTeam = {
  league: "NBA",
  collection_slug: "nba_top_shot",
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  team_name: "Portland Trail Blazers",
  route_slug: "portland-trail-blazers",
  primary_color: "#E03A2F",
  secondary_color: "#000",
  abbreviation: "POR",
  external_id: "1610612757",
  is_primary: true,
}

function rpcClient(byName: Record<string, { data?: unknown; error?: { message: string } }>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
  return {
    calls,
    db: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args })
        const r = byName[fn] ?? {}
        return { data: r.data ?? null, error: r.error ?? null }
      },
    },
  }
}

function tableClient(result: { data?: unknown; error?: { message: string } }) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "not", "order", "limit"]) b[m] = () => b
  b.maybeSingle = async () => ({ data: result.data ?? null, error: result.error ?? null })
  return { from: () => b }
}

describe("fetchFanTeams", () => {
  afterEach(() => vi.restoreAllMocks())

  it("a FAILED read reports ok:false — the page must not say you follow nothing", async () => {
    // ⚠ THE DEFECT. This returned a bare `[]`, and the page renders zero teams
    // as "Follow a team to build your hub" with two suggested teams. A
    // collector who follows six was told they follow none and invited to start
    // over — the same shape as /alerts inviting a duplicate of an alert you
    // already have.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = rpcClient({
      get_my_fan_teams: { error: { message: "canceling statement due to statement timeout" } },
    })
    expect(await fetchFanTeams(db)).toEqual({ teams: [], ok: false })
  })

  it("a genuinely empty follow list is ok:true — the prompt is RIGHT for that reader", async () => {
    // The mirror-image defect. A new account really does follow no teams, and
    // suppressing the prompt for them would leave a blank page with nothing to
    // do. Both directions have to hold or the fix just moves the dishonesty.
    const { db } = rpcClient({ get_my_fan_teams: { data: [] } })
    expect(await fetchFanTeams(db)).toEqual({ teams: [], ok: true })
  })

  it("a non-array payload degrades to an empty list rather than crashing the page", async () => {
    // The page maps over this immediately; a scalar would throw during render.
    const { db } = rpcClient({ get_my_fan_teams: { data: { oops: true } } })
    expect(await fetchFanTeams(db)).toEqual({ teams: [], ok: true })
  })

  it("returns the followed teams", async () => {
    const { db, calls } = rpcClient({ get_my_fan_teams: { data: [TEAM] } })
    expect(await fetchFanTeams(db)).toEqual({ teams: [TEAM], ok: true })
    // Reads through the SESSION client with no args: the RPC is granted to
    // `authenticated` and scopes itself on auth.uid(). Passing a user id here
    // would be a second, weaker source of truth for whose teams these are.
    expect(calls).toEqual([{ fn: "get_my_fan_teams", args: {} }])
  })
})

describe("fetchBoundWallet", () => {
  afterEach(() => vi.restoreAllMocks())

  it("a FAILED read is ok:false, distinct from having no wallet", async () => {
    // ⚠ The page renders a null wallet as "Add a wallet address or Top Shot
    // username on your profile" — telling its owner to add the wallet they
    // already added. Three states, not two.
    vi.spyOn(console, "log").mockImplementation(() => {})
    const db = tableClient({ error: { message: "boom" } })
    expect(await fetchBoundWallet(db, "u1")).toEqual({ wallet: null, ok: false })
  })

  it("no saved wallet is ok:true — the prompt is the point for that reader", async () => {
    const db = tableClient({ data: null })
    expect(await fetchBoundWallet(db, "u1")).toEqual({ wallet: null, ok: true })
  })

  it("a blank or whitespace wallet counts as none, not as an address", async () => {
    // A whitespace value would otherwise be threaded into get_team_checklist_progress
    // as `p_wallet`, which silently returns a completion of zero — a measured-
    // looking 0% for a collector who owns half the set.
    const db = tableClient({ data: { wallet_addr: "   " } })
    expect(await fetchBoundWallet(db, "u1")).toEqual({ wallet: null, ok: true })
  })

  it("trims a real address", async () => {
    const db = tableClient({ data: { wallet_addr: " 0xbd94cade097e50ac " } })
    expect(await fetchBoundWallet(db, "u1")).toEqual({ wallet: "0xbd94cade097e50ac", ok: true })
  })
})

describe("fetchTeamCard", () => {
  it("unwraps a single-row detail whether the RPC returns an array or an object", async () => {
    const detail = { fmv_total_usd: 100, sales_30d: 4 }
    for (const payload of [detail, [detail]]) {
      const { db } = rpcClient({
        get_team_detail: { data: payload },
        get_team_checklist_progress: { data: { owned: 3, total: 10 } },
      })
      const r = await fetchTeamCard(TEAM, "0xabc", db)
      expect(r.detail).toEqual(detail)
    }
  })

  it("REJECTS an array for progress, where it unwraps one for detail", async () => {
    // ⚠ Not a copy-paste slip — the two shapes differ. `get_team_checklist_progress`
    // returns ONE row, so an array means the RPC's shape changed underneath us,
    // and taking [0] would render a completion bar from a payload nobody
    // verified. The safe answer is "no progress", which the page omits.
    const { db } = rpcClient({
      get_team_detail: { data: { fmv_total_usd: 1 } },
      get_team_checklist_progress: { data: [{ owned: 3, total: 10 }] },
    })
    expect((await fetchTeamCard(TEAM, "0xabc", db)).progress).toBeNull()
  })

  it("a failed card read degrades to nulls without reporting a failure", async () => {
    // Deliberate: both halves render as an OMISSION (the stat row and the
    // completion bar simply do not appear), which understates. A per-card
    // failure flag would put up to N banners on one page for one blip, and
    // neither half makes a claim the reader could mistake for a measurement.
    const { db } = rpcClient({
      get_team_detail: { error: { message: "boom" } },
      get_team_checklist_progress: { error: { message: "boom" } },
    })
    expect(await fetchTeamCard(TEAM, "0xabc", db)).toEqual({ detail: null, progress: null })
  })

  it("threads the wallet into the progress RPC, and a null wallet stays null", async () => {
    // A null wallet must reach the RPC as null rather than as a string, or the
    // checklist is computed against a wallet named "null".
    const { db, calls } = rpcClient({})
    await fetchTeamCard(TEAM, null, db)
    const progress = calls.find((c) => c.fn === "get_team_checklist_progress")
    expect(progress?.args).toMatchObject({ p_wallet: null, p_scope: "all_time" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDS — a read that HANGS must reach the same honest branch as one that errors.
//
// ⚠ The three functions above already distinguished a failed read from an empty
// one, and `/my-teams` already renders that distinction. What none of them could
// reach was the failure this class actually produces: **a read that is merely
// SLOW errors nowhere.** supabase-js resolves `{ data, error }` only when the
// query finishes, so under DB saturation the page hangs on a streaming shell —
// logged by Vercel as a 200, with no error anywhere to branch on.
//
// ⚠ So the honesty work was already done and was UNREACHABLE from the most
// likely failure mode. That is worth stating plainly, because "the page has an
// ok:false branch" reads like coverage and, for a hang, was not.
// ─────────────────────────────────────────────────────────────────────────────

/** A client whose terminal call never settles. */
function hangingRpcClient() {
  return { rpc: () => new Promise<never>(() => {}) }
}

function hangingTableClient() {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "not", "order", "limit"]) b[m] = () => b
  b.maybeSingle = () => new Promise(() => {})
  return { from: () => b }
}

describe("bounds — a hung read is a failed read, not an empty account", () => {
  it("fetchFanTeams reports ok:false rather than hanging", async () => {
    const res = await fetchFanTeams(hangingRpcClient())

    expect(res.ok, "an overrun read must report FAILURE").toBe(false)
    // ⚠ Assert the ABSENCE of the false claim, not merely the presence of a
    // flag: `{ teams: [], ok: true }` is what tells a collector who follows six
    // teams to go follow their first one.
    expect(res.teams.length === 0 && res.ok === true).toBe(false)
  }, 20_000)

  it("fetchBoundWallet reports ok:false rather than hanging", async () => {
    const res = await fetchBoundWallet(hangingTableClient(), "user-1")

    expect(res.ok).toBe(false)
    expect(res.wallet === null && res.ok === true, "must not read as 'no wallet pinned'").toBe(false)
  }, 20_000)

  it("fetchTeamCard degrades to omission rather than hanging", async () => {
    // ⚠ The doc comment on `fetchTeamCard` says a failure here renders as an
    // OMISSION and therefore needs no `ok` flag. The bound must land in that
    // same shape — it exists to make an existing state reachable, not to add one.
    const res = await fetchTeamCard(TEAM, "0xabc", hangingRpcClient())

    expect(res).toEqual({ detail: null, progress: null })
  }, 20_000)

  it("CONTROL — a read inside the budget still resolves normally", async () => {
    // Without this, a stub that always failed would satisfy all three above and
    // this block would report coverage for functions that had stopped working.
    const { db } = rpcClient({ get_my_fan_teams: { data: [TEAM] } })
    const res = await fetchFanTeams(db)

    expect(res.ok).toBe(true)
    expect(res.teams).toHaveLength(1)
  })

  it("CONTROL — a genuinely empty follow list is still ok:true", async () => {
    // The branch the bound must not swallow: we asked, and the answer is "none".
    const { db } = rpcClient({ get_my_fan_teams: { data: [] } })
    const res = await fetchFanTeams(db)

    expect(res).toEqual({ teams: [], ok: true })
  })
})
