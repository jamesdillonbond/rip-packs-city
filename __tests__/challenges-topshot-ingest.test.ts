import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Tests for the Top Shot VARIABLE-challenge ingest (confirmed shape from a live
// SearchChallenges capture: searchChallenges.data.searchSummary.data.data[] of UserChallenge
// nodes, each type "VARIABLE" with variableChallenge.variableSlots[].query
// {byPlayers,bySets,bySeries,byPlayCategory}). mapChallenge is pure; fetchTopshotChallenges +
// ingestTopshotChallenges run against a mocked global fetch. Env is read lazily, so a
// statically imported module picks up TS_PROXY_SECRET set in beforeEach.

import {
  mapChallenge,
  fetchTopshotChallenges,
  ingestTopshotChallenges,
  challengeIngestEnabled,
} from "@/lib/challenges/topshot-ingest"

const origFetch = globalThis.fetch
const gqlResponse = (body: any) =>
  vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })) as any

// Build a minimal searchChallenges envelope around a list of UserChallenge nodes.
const envelope = (nodes: any[]) => ({
  data: { searchChallenges: { data: { searchSummary: { data: { data: nodes } } } } },
})

const goodNode = {
  id: "3582c375",
  name: "2026 NBA Playoffs Set Challenge",
  description: "Lock moments",
  expirationDate: "2026-07-14T03:00:00Z",
  numUsersCompleted: 191,
  type: "VARIABLE",
  variableChallenge: {
    prize: "",
    assets: { image: "https://img/challenge.png" },
    variableSlots: [
      { slotOrder: 1, label: "James Harden", helpText: "2026 NBA Playoffs", query: { byPlayers: ["201935"], bySets: ["edbf04d6"], bySeries: ["8"], byPlayCategory: null } },
      { slotOrder: 6, label: "Jalen Brunson", helpText: null, query: { byPlayers: ["1628973"], bySets: ["edbf04d6"], bySeries: ["8"], byPlayCategory: ["3 Pointer"] } },
    ],
  },
}

beforeEach(() => {
  process.env.TS_PROXY_SECRET = "test-secret"
})
afterEach(() => {
  globalThis.fetch = origFetch
  delete process.env.CHALLENGE_INGEST_ENABLED
  vi.restoreAllMocks()
})

describe("challengeIngestEnabled", () => {
  it("is true only when CHALLENGE_INGEST_ENABLED === 'true'", () => {
    process.env.CHALLENGE_INGEST_ENABLED = "true"
    expect(challengeIngestEnabled()).toBe(true)
    process.env.CHALLENGE_INGEST_ENABLED = "1"
    expect(challengeIngestEnabled()).toBe(false)
    delete process.env.CHALLENGE_INGEST_ENABLED
    expect(challengeIngestEnabled()).toBe(false)
  })
})

describe("mapChallenge", () => {
  it("maps variableSlots to slot queries and hoists the shared set UUID", () => {
    const out = mapChallenge(goodNode)
    expect(out.externalId).toBe("3582c375")
    expect(out.name).toBe("2026 NBA Playoffs Set Challenge")
    expect(out.endsAt).toBe("2026-07-14T03:00:00Z")
    expect(out.completedCount).toBe(191)
    expect(out.imageUrl).toBe("https://img/challenge.png")
    expect(out.setExternalId).toBe("edbf04d6")
    expect(out.slots).toHaveLength(2)
    expect(out.slots[0]).toMatchObject({ slotOrder: 1, label: "James Harden", nbaStatsId: "201935", playCategory: null, series: "8" })
    expect(out.slots[1]).toMatchObject({ slotOrder: 6, nbaStatsId: "1628973", playCategory: "3 Pointer" })
  })

  it("throws when there are no variable slots (never seeds a half-formed challenge)", () => {
    expect(() => mapChallenge({ id: "x", name: "Empty", variableChallenge: { variableSlots: [] } })).toThrow()
    expect(() => mapChallenge({ id: "x", name: "Empty" })).toThrow()
  })

  it("throws when slots carry no set UUID (cannot resolve editions)", () => {
    expect(() =>
      mapChallenge({ id: "y", name: "NoSet", variableChallenge: { variableSlots: [{ slotOrder: 1, label: "A", query: { byPlayers: ["1"] } }] } })
    ).toThrow()
  })
})

describe("fetchTopshotChallenges", () => {
  it("throws the guard when TS_PROXY_SECRET is unset (no fetch)", async () => {
    delete process.env.TS_PROXY_SECRET
    const spy = vi.fn()
    globalThis.fetch = spy as any
    await expect(fetchTopshotChallenges()).rejects.toThrow(/TS_PROXY_SECRET not set/)
    expect(spy).not.toHaveBeenCalled()
  })

  it("parses the searchChallenges shape and skips unmappable nodes", async () => {
    globalThis.fetch = gqlResponse(envelope([goodNode, { id: "b", name: "NoSlots", type: "VARIABLE", variableChallenge: { variableSlots: [] } }]))
    const out = await fetchTopshotChallenges()
    expect(out).toHaveLength(1)
    expect(out[0].externalId).toBe("3582c375")
    expect(out[0].slots[0].nbaStatsId).toBe("201935")
  })

  it("throws on an unexpected response shape (never writes junk)", async () => {
    globalThis.fetch = gqlResponse({ data: { somethingElse: {} } })
    await expect(fetchTopshotChallenges()).rejects.toThrow(/unexpected searchChallenges shape/)
  })

  it("surfaces GraphQL errors", async () => {
    globalThis.fetch = gqlResponse({ errors: [{ message: "nope" }] })
    await expect(fetchTopshotChallenges()).rejects.toThrow(/nope/)
  })
})

describe("ingestTopshotChallenges", () => {
  it("upserts each mapped challenge then resolves + refreshes once", async () => {
    globalThis.fetch = gqlResponse(envelope([goodNode]))
    const calls: any[] = []
    const rpc = vi.fn(async (fn: string, args: any) => { calls.push({ fn, args }); return { error: null } })
    const res = await ingestTopshotChallenges({ rpc })
    expect(res).toEqual({ fetched: 1, upserted: 1, skipped: 0, expired: 0 })
    expect(calls[0].fn).toBe("upsert_challenge_from_gql")
    expect(calls[0].args.p_external_id).toBe("3582c375")
    expect(calls[0].args.p_set_external_id).toBe("edbf04d6")
    expect(calls[0].args.p_slots[0]).toMatchObject({ slot_order: 1, nba_stats_id: "201935" })
    // resolve + refresh run once after upserts, then the expiry pass always runs
    expect(calls.map((c) => c.fn)).toEqual(["upsert_challenge_from_gql", "resolve_challenge_slots", "refresh_challenge_costs", "expire_ended_challenges"])
  })

  it("counts an upsert RPC error as skipped and does not resolve when nothing upserted", async () => {
    globalThis.fetch = gqlResponse(envelope([goodNode]))
    const calls: any[] = []
    const rpc = vi.fn(async (fn: string, args: any) => {
      calls.push({ fn, args })
      return { error: fn === "upsert_challenge_from_gql" ? { message: "boom" } : null }
    })
    const res = await ingestTopshotChallenges({ rpc })
    expect(res).toEqual({ fetched: 1, upserted: 0, skipped: 1, expired: 0 })
    // no resolve/refresh when zero upserted, but the expiry pass still runs every tick
    // (a challenge that dropped out of the feed is never upserted — only the time-based
    // flip keeps status honest)
    expect(calls.map((c) => c.fn)).toEqual(["upsert_challenge_from_gql", "expire_ended_challenges"])
  })
})
