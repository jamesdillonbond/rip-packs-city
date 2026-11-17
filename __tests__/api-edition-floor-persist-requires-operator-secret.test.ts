// Deep-audit R2 (P0, latent). `/api/edition-floor` is anon-reachable by design
// (proxy.ts opens GET/HEAD/POST as a "stateless read-compute"), but `persist`
// was taken straight from the caller and ran `persistFloorToSnapshot`, which
// builds a SERVICE_ROLE client and DELETEs today's `fmv_snapshots` rows for up
// to 50 editions before re-inserting. An unauthenticated request could destroy
// live pricing data.
//
// ⚠ `check_anon_write_surface()` cannot catch this by construction — it tests
// the anon DB ROLE, and this route holds the service-role key.
//
// Pinned in BOTH directions: an unauthenticated `persist` must NOT write, and
// an operator-authenticated one still must, or the gate silently kills the
// feature instead of securing it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const createClientSpy = vi.fn()

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    createClientSpy(...args)
    // A client whose every builder resolves empty — persistFloorToSnapshot
    // bails at the first read, so no further stubbing is needed to observe
    // whether it was ENTERED at all.
    const builder: Record<string, unknown> = {}
    for (const m of ["select", "in", "order", "delete", "gte", "insert", "eq"]) {
      builder[m] = () => builder
    }
    builder.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
    return { from: () => builder }
  },
}))

// The floor resolver does network work; stub it out entirely.
vi.mock("@/lib/cross-market-floor", () => ({
  selectCrossMarketFloor: () => ({ floor: 1.23, source: "test" }),
}))

// ⚠ This stub must model a SUCCESSFUL marketplace lookup. It used to return
// `{ ok: false, status: 503 }`, which was harmless only while the route served
// a failed venue fetch as a 200 with null floors. Now that a failed lookup
// correctly 503s (an outage is not an empty order book), a failing stub would
// short-circuit the handler before it ever reaches the persist branch — so
// every assertion below would pass for the wrong reason, proving nothing about
// the authorization gate this file exists to pin.
const TS_GQL_OK = {
  data: {
    searchEditions: {
      data: {
        searchSummary: {
          data: { data: [{ setID: "1", playID: "2", lowestAsk: 1.23, forSaleCount: 2 }] },
        },
      },
    },
  },
}
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({ ok: true, status: 200, json: async () => TS_GQL_OK })) as never,
)

const OLD_ENV = { ...process.env }

describe("/api/edition-floor — persist is operator-only", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = "cron-test-secret"
    process.env.INGEST_SECRET_TOKEN = "ingest-test-secret"
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  })
  afterEach(() => {
    process.env = { ...OLD_ENV }
  })

  async function post(body: unknown, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/api/edition-floor/route")
    const { NextRequest } = await import("next/server")
    const req = new NextRequest("https://www.rippackscity.com/api/edition-floor", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    return POST(req)
  }

  async function get(url: string, headers: Record<string, string> = {}) {
    const { GET } = await import("@/app/api/edition-floor/route")
    const { NextRequest } = await import("next/server")
    return GET(new NextRequest(url, { method: "GET", headers }))
  }

  it("POST persist:true with NO auth does not construct a service-role client", async () => {
    const res = await post({ editionKeys: ["a:b"], persist: true })
    expect(res.status).toBe(200)
    // The service-role client is only built on the persist path.
    expect(createClientSpy).not.toHaveBeenCalled()
  })

  it("POST persist:true with a WRONG bearer does not construct a service-role client", async () => {
    const res = await post(
      { editionKeys: ["a:b"], persist: true },
      { authorization: "Bearer not-the-secret" },
    )
    expect(res.status).toBe(200)
    expect(createClientSpy).not.toHaveBeenCalled()
  })

  it("GET ?persist=1 with NO auth does not construct a service-role client", async () => {
    const res = await get("https://www.rippackscity.com/api/edition-floor?editionKey=a:b&persist=1")
    expect(res.status).toBe(200)
    expect(createClientSpy).not.toHaveBeenCalled()
  })

  it("POST persist:true WITH the operator secret still persists (the gate secures, not disables)", async () => {
    const res = await post(
      { editionKeys: ["a:b"], persist: true },
      { authorization: "Bearer ingest-test-secret" },
    )
    expect(res.status).toBe(200)
    expect(createClientSpy).toHaveBeenCalled()
  })

  it("the CRON_SECRET is accepted too", async () => {
    const res = await post(
      { editionKeys: ["a:b"], persist: true },
      { authorization: "Bearer cron-test-secret" },
    )
    expect(res.status).toBe(200)
    expect(createClientSpy).toHaveBeenCalled()
  })

  it("the anonymous READ path is unchanged — no auth, no persist, still 200", async () => {
    const res = await get("https://www.rippackscity.com/api/edition-floor?editionKey=a:b")
    expect(res.status).toBe(200)
    expect(createClientSpy).not.toHaveBeenCalled()
  })
})
