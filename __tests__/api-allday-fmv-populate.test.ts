import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-fmv-populate (cursor-sweep cron).
// Auth: Bearer INGEST_SECRET_TOKEN or ?token=, captured into a module-level
// TOKEN at import, so a missing/empty server token or a wrong caller token -> 401
// before any GQL fan-out. We exercise BOTH regimes by resetting modules between:
//   A. secret DELETED -> TOKEN === "" -> every request 401s (fail-closed).
//   B. secret SET      -> wrong/no token 401s, correct token reaches the 200
//      sweep. The upstream marketplace GQL fetch is stubbed to an empty,
//      completed page, so the sweep runs end to end with zero editions and no
//      live network, upserts nothing and returns { ok:true, editions_fetched:0 }.

const stateRow = {
  current: { cursor: null, total_ingested: 0, status: "complete", last_run_at: null } as any,
}
const sb: any = {
  from: () => sb,
  select: () => sb,
  eq: () => sb,
  in: () => sb,
  order: () => sb,
  limit: () => sb,
  update: () => sb,
  single: async () => ({ data: stateRow.current, error: null }),
  rpc: async () => ({ data: null, error: null }),
  then: (resolve: any) => resolve({ data: [], error: null }),
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb }))
vi.mock("@/lib/chains/flow/allday-video", () => ({
  backfillAllDayEditionVideos: async () => ({ scanned: 0, updated: 0 }),
}))

const url = "https://t/api/allday-fmv-populate"
function req(auth?: string, token?: string): NextRequest {
  const full = token ? `${url}?token=${token}` : url
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest(full, { headers })
}

describe("GET /api/allday-fmv-populate — no secret configured (fail-closed)", () => {
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    GET = (await import("@/app/api/allday-fmv-populate/route")).GET as any
  })

  it("401s without an authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/allday-fmv-populate — secret configured (success path)", () => {
  const TOKEN = "test-ingest-token"
  const realFetch = globalThis.fetch
  let GET: (req: any) => Promise<Response>

  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            searchMarketplaceEditions: {
              pageInfo: { endCursor: null, hasNextPage: false },
              edges: [],
            },
          },
        }),
    })) as any
    GET = (await import("@/app/api/allday-fmv-populate/route")).GET as any
  })

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  it("still 401s with no token", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("200s with the correct bearer token and reports an empty completed sweep", async () => {
    stateRow.current = { cursor: null, total_ingested: 0, status: "complete", last_run_at: null }
    const res = await GET(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editions_fetched).toBe(0)
    expect(body.sweep_complete).toBe(true)
  })

  it("200s with the correct ?token= query param", async () => {
    stateRow.current = { cursor: null, total_ingested: 0, status: "complete", last_run_at: null }
    expect((await GET(req(undefined, TOKEN))).status).toBe(200)
  })
})
