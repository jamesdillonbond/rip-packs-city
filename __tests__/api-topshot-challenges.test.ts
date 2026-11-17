import { describe, it, expect, beforeEach, vi } from "vitest"

// Route tests for the Top Shot challenge tracker:
//   GET  /api/topshot/challenges        (get_active_challenges)
//   GET  /api/topshot/challenge-plan    (get_challenge_plan)
//   POST /api/admin/challenges/upsert   (upsert_challenge, Bearer INGEST_SECRET_TOKEN)
// Mocks @supabase/supabase-js createClient so every .rpc() resolves `rpcResult`,
// which each test sets. Pins the param/auth guards + the success/accept paths.

let rpcResult: { data: any; error: any } = { data: null, error: null }
let lastRpc: { fn: string; args: any } | null = null

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: any) => {
      lastRpc = { fn, args }
      return rpcResult
    },
  }),
}))

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://t.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"
process.env.INGEST_SECRET_TOKEN = "test-token"

import { GET as getChallenges } from "@/app/api/topshot/challenges/route"
import { GET as getPlan } from "@/app/api/topshot/challenge-plan/route"
import { POST as upsert } from "@/app/api/admin/challenges/upsert/route"

const getReq = (url: string) => ({ url }) as any
const postReq = (body: any, auth?: string) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
    json: async () => body,
  }) as any

const UUID = "f5e165b1-41a3-464b-bb8e-273b30fc5dee"

beforeEach(() => {
  rpcResult = { data: null, error: null }
  lastRpc = null
})

describe("GET /api/topshot/challenges", () => {
  it("400s on a malformed wallet", async () => {
    const res = await getChallenges(getReq("https://t/api/topshot/challenges?wallet=nope"))
    expect(res.status).toBe(400)
  })

  it("returns the active-challenge board (wallet omitted → p_wallet null)", async () => {
    rpcResult = { data: { activeCount: 2, challenges: [{ name: "X", netEv: 12 }] }, error: null }
    const res = await getChallenges(getReq("https://t/api/topshot/challenges"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.activeCount).toBe(2)
    expect(lastRpc?.fn).toBe("get_active_challenges")
    expect(lastRpc?.args.p_wallet).toBeNull()
  })

  it("passes a valid wallet through", async () => {
    rpcResult = { data: { activeCount: 0, challenges: [] }, error: null }
    const res = await getChallenges(getReq("https://t/api/topshot/challenges?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    expect(lastRpc?.args.p_wallet).toBe("0xbd94cade097e50ac")
  })
})

describe("GET /api/topshot/challenge-plan", () => {
  it("400s without a valid challengeId", async () => {
    const res = await getPlan(getReq("https://t/api/topshot/challenge-plan?challengeId=abc"))
    expect(res.status).toBe(400)
  })

  it("404s when the challenge is not found", async () => {
    rpcResult = { data: null, error: null }
    const res = await getPlan(getReq(`https://t/api/topshot/challenge-plan?challengeId=${UUID}`))
    expect(res.status).toBe(404)
  })

  it("returns the plan on a hit", async () => {
    rpcResult = { data: { name: "2021 Finals Lock", costToComplete: 10, netEv: -5, missing: [] }, error: null }
    const res = await getPlan(getReq(`https://t/api/topshot/challenge-plan?challengeId=${UUID}&wallet=0xbd94cade097e50ac`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe("2021 Finals Lock")
    expect(lastRpc?.args.p_challenge_id).toBe(UUID)
  })
})

describe("POST /api/admin/challenges/upsert", () => {
  it("401s without the ingest bearer", async () => {
    const res = await upsert(postReq({ slug: "s", name: "n" }))
    expect(res.status).toBe(401)
  })

  it("400s when slug/name are missing", async () => {
    const res = await upsert(postReq({}, "Bearer test-token"))
    expect(res.status).toBe(400)
  })

  it("upserts and normalizes the edition list to snake_case jsonb", async () => {
    rpcResult = { data: "new-uuid", error: null }
    const res = await upsert(
      postReq(
        {
          slug: "s1",
          name: "Challenge 1",
          rewardKind: "pack",
          rewardPackDistId: 468,
          editions: [{ externalId: "41:1461", playIdOnchain: 1461 }, { external_id: "" }],
        },
        "Bearer test-token"
      )
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.challengeId).toBe("new-uuid")
    expect(body.editionCount).toBe(1) // the empty-external_id row is filtered out
    expect(lastRpc?.fn).toBe("upsert_challenge")
    expect(lastRpc?.args.p_reward_pack_dist_id).toBe("468") // coerced to text
    expect(lastRpc?.args.p_editions[0].external_id).toBe("41:1461")
  })
})
