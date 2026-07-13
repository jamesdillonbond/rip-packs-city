import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Tests for the Top Shot challenge-definition ingest (confirmed GraphQL shape:
// getActiveChallenges { challenges { id name description type reward{setID playID}
// slots{setID playID} } }). Env is read lazily inside the module, so a statically
// imported module picks up TS_PROXY_SECRET set in beforeEach. mapChallenge is pure;
// fetchTopshotChallenges + ingestTopshotChallenges run against a mocked global fetch.

import {
  mapChallenge,
  fetchTopshotChallenges,
  ingestTopshotChallenges,
  challengeIngestEnabled,
} from "@/lib/challenges/topshot-ingest"

const origFetch = globalThis.fetch
const gqlResponse = (body: any) =>
  vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })) as any

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
  it("maps slots to setID:playID editions (deduped) and reward to a moment", () => {
    const out = mapChallenge({
      id: "abc123",
      name: "Playoff Push",
      description: "Lock 3 moments",
      type: "SET_LOCKING",
      reward: { setID: 100, playID: 9000 },
      slots: [
        { setID: 41, playID: 1461 },
        { setID: 41, playID: 1462 },
        { setID: 41, playID: 1461 }, // dup → deduped
      ],
    })
    expect(out.slug).toBe("ts-abc123")
    expect(out.challengeType).toBe("set_locking")
    expect(out.source).toBe("topshot_gql")
    expect(out.rewardKind).toBe("moment")
    expect(out.rewardMomentExternalId).toBe("100:9000")
    expect(out.editions.map((e) => e.externalId)).toEqual(["41:1461", "41:1462"])
    expect(out.editions[0].playIdOnchain).toBe(1461)
  })

  it("maps crafting type and null reward when reward ids are zero/absent", () => {
    const out = mapChallenge({
      id: "c2",
      name: "Burn It",
      type: "CRAFTING_CHALLENGE",
      reward: { setID: 0, playID: 0 },
      slots: [{ setID: 5, playID: 7 }],
    })
    expect(out.challengeType).toBe("crafting")
    expect(out.rewardKind).toBeNull()
    expect(out.rewardMomentExternalId).toBeNull()
  })

  it("throws when there is no required-moment list (never seeds a half-formed challenge)", () => {
    expect(() => mapChallenge({ id: "x", name: "Empty", slots: [] })).toThrow()
    expect(() => mapChallenge({ id: "x", name: "Empty", slots: [{ setID: 0, playID: 3 }] })).toThrow()
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

  it("parses the getActiveChallenges shape and skips unmappable nodes", async () => {
    globalThis.fetch = gqlResponse({
      data: {
        getActiveChallenges: {
          challenges: [
            { id: "a", name: "Good", type: "SET_LOCKING", reward: { setID: 1, playID: 2 }, slots: [{ setID: 3, playID: 4 }] },
            { id: "b", name: "NoSlots", slots: [] }, // dropped
          ],
        },
      },
    })
    const out = await fetchTopshotChallenges()
    expect(out).toHaveLength(1)
    expect(out[0].slug).toBe("ts-a")
    expect(out[0].editions[0].externalId).toBe("3:4")
  })

  it("throws on an unexpected response shape (never writes junk)", async () => {
    globalThis.fetch = gqlResponse({ data: { somethingElse: {} } })
    await expect(fetchTopshotChallenges()).rejects.toThrow(/unexpected getActiveChallenges shape/)
  })

  it("surfaces GraphQL errors", async () => {
    globalThis.fetch = gqlResponse({ errors: [{ message: "nope" }] })
    await expect(fetchTopshotChallenges()).rejects.toThrow(/nope/)
  })
})

describe("ingestTopshotChallenges", () => {
  it("upserts each mapped challenge and reports counts", async () => {
    globalThis.fetch = gqlResponse({
      data: {
        getActiveChallenges: {
          challenges: [
            { id: "a", name: "One", type: "SET_LOCKING", reward: { setID: 1, playID: 2 }, slots: [{ setID: 3, playID: 4 }] },
            { id: "z", name: "Bad", slots: [] }, // unmappable → not fetched
          ],
        },
      },
    })
    const calls: any[] = []
    const rpc = vi.fn(async (fn: string, args: any) => { calls.push({ fn, args }); return { error: null } })
    const res = await ingestTopshotChallenges({ rpc })
    expect(res).toEqual({ fetched: 1, upserted: 1, skipped: 0 })
    expect(calls[0].fn).toBe("upsert_challenge")
    expect(calls[0].args.p_source).toBe("topshot_gql")
    expect(calls[0].args.p_editions[0]).toEqual({ external_id: "3:4", play_id_onchain: 4 })
  })

  it("counts an upsert RPC error as skipped, not upserted", async () => {
    globalThis.fetch = gqlResponse({
      data: {
        getActiveChallenges: {
          challenges: [{ id: "a", name: "One", type: "SET_LOCKING", reward: { setID: 1, playID: 2 }, slots: [{ setID: 3, playID: 4 }] }],
        },
      },
    })
    const rpc = vi.fn(async () => ({ error: { message: "boom" } }))
    const res = await ingestTopshotChallenges({ rpc })
    expect(res).toEqual({ fetched: 1, upserted: 0, skipped: 1 })
  })
})
