import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for POST /api/cost-basis-gql-backfill. Fail-closed Bearer
// auth (INGEST_SECRET_TOKEN read at import). Deep legs added: getOwnedIds throw
// →500, the moment-processing loop (fetchMomentData priced→insert / no-price /
// non-ok→gqlError), the already-covered skip via moment_acquisitions, the upsert
// error branch, and the pagination (done / nextOffset / remaining). Distinct
// wallets per test dodge the in-module 10-min owned-ids cache.

process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"

const st = {
  owned: [] as any,
  ownedThrows: false,
  existing: [] as { nft_id: string }[],
  insertErr: null as any,
}

vi.mock("@/lib/chains/flow/flow", () => ({
  default: { query: async () => { if (st.ownedThrows) throw new Error("cadence down"); return st.owned } },
}))
vi.mock("@onflow/types", () => ({ Address: "Address" }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from() {
      const b: any = {
        select: () => b, eq: () => b, in: () => b,
        upsert: async () => ({ error: st.insertErr }),
        then: (resolve: any) => resolve({ data: st.existing, error: null }),
      }
      return b
    },
  }),
}))

const AUTH = "Bearer test-ingest-secret"
function req(opts: { auth?: string; body?: any } = {}): any {
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return { method: "POST", headers, json: async () => opts.body ?? {} }
}
async function loadPOST() {
  return (await import("@/app/api/cost-basis-gql-backfill/route")).POST
}

let fetchMock: any
// price per flowId; missing → null data (gqlError), 0 → no price
let priceById: Record<string, number | null> = {}
function installFetch() {
  fetchMock = vi.fn(async (_url: string, init: any) => {
    const id = JSON.parse(init.body).variables.momentId
    const price = priceById[id]
    if (price === undefined) return { ok: false, status: 500, json: async () => ({}) } // gqlError
    return { ok: true, json: async () => ({ data: { getMintedMoment: { data: { lastPurchasePrice: price, createdAt: "2026-01-01T00:00:00Z", play: { stats: { playerName: "X" } } } } } }) }
  })
  vi.stubGlobal("fetch", fetchMock)
}

beforeEach(() => {
  st.owned = []; st.ownedThrows = false; st.existing = []; st.insertErr = null
  priceById = {}
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

describe("POST /api/cost-basis-gql-backfill — guards", () => {
  it("401s with no Authorization header", async () => {
    const POST = await loadPOST()
    expect((await POST(req({ body: { wallet: "0xabcdef0123456789" } }))).status).toBe(401)
  })
  it("401s with a wrong bearer", async () => {
    const POST = await loadPOST()
    expect((await POST(req({ auth: "Bearer nope", body: { wallet: "0xabcdef0123456789" } }))).status).toBe(401)
  })
  it("400s on a malformed wallet", async () => {
    const POST = await loadPOST()
    const res = await POST(req({ auth: AUTH, body: { wallet: "xyz" } }))
    expect(res.status).toBe(400)
  })
  it("500s when the owned-ids Cadence query throws", async () => {
    st.ownedThrows = true
    const POST = await loadPOST()
    const res = await POST(req({ auth: AUTH, body: { wallet: "0x1111111111111111" } }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to fetch owned IDs")
  })
  it("done:true when the wallet owns no moments", async () => {
    st.owned = []
    const POST = await loadPOST()
    const body = await (await POST(req({ auth: AUTH, body: { wallet: "0x2222222222222222" } }))).json()
    expect(body.done).toBe(true)
    expect(body.total).toBe(0)
  })
})

describe("POST /api/cost-basis-gql-backfill — processing loop", () => {
  it("inserts priced moments, counts no-price + gqlErrors, and skips existing", async () => {
    st.owned = ["a1", "a2", "a3", "a4"]
    st.existing = [{ nft_id: "a1" }] // a1 already covered → skipped
    priceById = { a2: 25, a3: 0 } // a2 priced (insert), a3 no-price, a4 missing → gqlError
    const POST = await loadPOST()
    const body = await (await POST(req({ auth: AUTH, body: { wallet: "0x3333333333333333", limit: 200 } }))).json()
    expect(body.processed).toBe(4)
    expect(body.skippedExisting).toBe(1)
    expect(body.inserted).toBe(1)
    expect(body.noPrice).toBe(1)
    expect(body.gqlErrors).toBe(1)
    expect(body.done).toBe(true)
  })

  it("tolerates an upsert error (inserted stays 0)", async () => {
    st.owned = ["b1"]
    priceById = { b1: 10 }
    st.insertErr = { message: "insert down" }
    const POST = await loadPOST()
    const body = await (await POST(req({ auth: AUTH, body: { wallet: "0x4444444444444444" } }))).json()
    expect(body.inserted).toBe(0)
  })

  it("paginates: reports nextOffset + remaining when more IDs follow", async () => {
    st.owned = ["c1", "c2", "c3"]
    priceById = {}
    const POST = await loadPOST()
    const body = await (await POST(req({ auth: AUTH, body: { wallet: "0x5555555555555555", offset: 0, limit: 1 } }))).json()
    expect(body.done).toBe(false)
    expect(body.nextOffset).toBe(1)
    expect(body.remaining).toBe(2)
  })
})
