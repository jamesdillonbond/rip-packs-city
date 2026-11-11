import { describe, it, expect, beforeEach, vi } from "vitest"

// The two anon-public trophy reads (2026-11-06):
//   app/api/public/trophy-cases/route.ts
//   app/api/public/trophy-challenges/[slug]/route.ts
// ⚠ A failed read is a retryable 503, never `{ cases: [] }` / an empty board —
// both of those are claims about a collector or a challenge.

const state: { rpc: { data: any; error: any }; lastRpc: any; who: { data: any; error: any }; lastIlike: any } = {
  rpc: { data: [], error: null },
  lastRpc: null,
  who: { data: [{ user_id: "u1" }], error: null },
  lastIlike: null,
}

vi.mock("@/lib/supabase", () => {
  const client: any = {
    rpc: async (fn: string, args: any) => {
      state.lastRpc = { fn, args }
      return state.rpc
    },
    // profile_bio existence check (#237): .from().select().ilike().limit()
    from: (_t: string) => ({
      select: () => ({
        ilike: (_col: string, v: string) => {
          state.lastIlike = v
          return { limit: async () => state.who }
        },
      }),
    }),
  }
  return { supabase: client, supabaseAdmin: client }
})

// the challenge's open reward drop (2026-11-10)
const reward: { value: unknown; fail: boolean; lastSlug: string | null } = { value: null, fail: false, lastSlug: null }
vi.mock("@/lib/giveaways/challenge-reward", () => ({
  openRewardDropForChallenge: async (_db: unknown, slug: string) => {
    reward.lastSlug = slug
    if (reward.fail) throw new Error("giveaway_drops read failed: timeout")
    return reward.value
  },
}))

import { GET as casesGET } from "@/app/api/public/trophy-cases/route"
import { GET as boardGET } from "@/app/api/public/trophy-challenges/[slug]/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const TIMEOUT = { message: "canceling statement due to statement timeout", code: "57014" }

beforeEach(() => {
  state.rpc = { data: [], error: null }
  state.lastRpc = null
  state.who = { data: [{ user_id: "u1" }], error: null }
  state.lastIlike = null
})

describe("GET /api/public/trophy-cases", () => {
  it("400s without a username", async () => {
    expect((await casesGET(req("https://x/api/public/trophy-cases"))).status).toBe(400)
  })

  it("returns the collector's cases via get_trophy_cases_by_username", async () => {
    state.rpc = { data: [{ id: "c1", name: "Dame Time", slabs: [] }], error: null }
    const res = await casesGET(req("https://x/api/public/trophy-cases?username=trev"))
    expect(res.status).toBe(200)
    expect((await res.json()).cases).toHaveLength(1)
    expect(state.lastRpc).toEqual({ fn: "get_trophy_cases_by_username", args: { p_username: "trev" } })
  })

  it("⚠ a failed read is a 503, never an empty list", async () => {
    state.rpc = { data: null, error: TIMEOUT }
    const res = await casesGET(req("https://x/api/public/trophy-cases?username=trev"))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.cases).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  // #237 (2026-11-08): the RPC answers [] for BOTH an unknown username and a
  // collector with no extra cases — three states, never two.
  it("an existing collector with no extra cases is 200 + []", async () => {
    state.rpc = { data: [], error: null }
    const res = await casesGET(req("https://x/api/public/trophy-cases?username=Trev"))
    expect(res.status).toBe(200)
    expect((await res.json()).cases).toEqual([])
  })

  it("⚠ a username nobody holds is a 404, not an empty list", async () => {
    state.rpc = { data: [], error: null }
    state.who = { data: [], error: null }
    const res = await casesGET(req("https://x/api/public/trophy-cases?username=nobody_here"))
    expect(res.status).toBe(404)
    expect((await res.json()).cases).toBeUndefined()
    // the lookup matches literally: _ and % are not wildcards
    expect(state.lastIlike).toBe(String.raw`nobody\_here`)
  })

  it("⚠ a failed existence lookup is a 503, not a claim either way", async () => {
    state.rpc = { data: [], error: null }
    state.who = { data: null, error: TIMEOUT }
    const res = await casesGET(req("https://x/api/public/trophy-cases?username=trev"))
    expect(res.status).toBe(503)
    expect((await res.json()).cases).toBeUndefined()
  })

  it("a collector WITH cases pays no lookup", async () => {
    state.rpc = { data: [{ id: "c1", slabs: [] }], error: null }
    await casesGET(req("https://x/api/public/trophy-cases?username=trev"))
    expect(state.lastIlike).toBeNull()
  })
})

describe("GET /api/public/trophy-challenges/[slug]", () => {
  const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) })

  it("returns the board", async () => {
    state.rpc = { data: { challenge: { slug: "dame-time", title: "Dame Time" }, entry_count: 0, entries: [] }, error: null }
    const res = await boardGET(req("https://x/"), ctx("dame-time"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge.title).toBe("Dame Time")
    // is_open is decided server-side; an inactive challenge is closed
    expect(body.is_open).toBe(false)
    expect(state.lastRpc.args).toEqual({ p_slug: "dame-time", p_limit: 48 })
  })

  it("carries the open reward drop for the challenge; none is null", async () => {
    state.rpc = { data: { challenge: { slug: "dame-time", title: "Dame Time" }, entry_count: 0, entries: [] }, error: null }
    reward.fail = false
    reward.value = { slug: "dame-time-challenge-reward-pack", title: "Dame Time Challenge Reward Pack" }
    const a = await (await boardGET(req("https://x/"), ctx("dame-time"))).json()
    expect(a.reward).toEqual({ slug: "dame-time-challenge-reward-pack", title: "Dame Time Challenge Reward Pack" })
    expect(a.reward_error).toBe(false)
    expect(reward.lastSlug).toBe("dame-time")
    reward.value = null
    const b = await (await boardGET(req("https://x/"), ctx("dame-time"))).json()
    expect(b.reward).toBeNull()
    expect(b.reward_error).toBe(false)
  })

  it("a failed reward read never takes the board down and is flagged, not reported as no reward", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    state.rpc = { data: { challenge: { slug: "dame-time", title: "Dame Time" }, entry_count: 1, entries: [{ username: "sdb" }] }, error: null }
    reward.fail = true
    const res = await boardGET(req("https://x/"), ctx("dame-time"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toHaveLength(1)
    expect(body.reward).toBeNull()
    expect(body.reward_error).toBe(true)
    reward.fail = false
  })

  it("an unknown slug (RPC NULL) is a 404", async () => {
    state.rpc = { data: null, error: null }
    expect((await boardGET(req("https://x/"), ctx("nope"))).status).toBe(404)
  })

  it("⚠ a failed read is a 503, never an empty board", async () => {
    state.rpc = { data: null, error: TIMEOUT }
    const res = await boardGET(req("https://x/"), ctx("dame-time"))
    expect(res.status).toBe(503)
    expect((await res.json()).entries).toBeUndefined()
  })
})
