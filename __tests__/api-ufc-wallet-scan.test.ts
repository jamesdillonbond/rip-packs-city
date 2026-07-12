import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"

// Route integration test for POST /api/ufc-wallet-scan. Guards run pre-network:
// malformed JSON → 400, non-0x wallet → 400. The secret is captured into a
// module-level `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import, so we
// exercise BOTH regimes with vi.resetModules():
//   A. secret DELETED → a valid 0x wallet 500s ("INGEST_SECRET_TOKEN not
//      configured") before any edge-function call.
//   B. secret SET      → the scan+enrich fan-out (mocked via a stubbed global
//      fetch that reports done:true on the first enrich chunk) reaches the 200
//      { ok:true, done:true } accept; the after() drain never registers.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedFetch = globalThis.fetch
afterAll(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  globalThis.fetch = savedFetch
})

describe("POST /api/ufc-wallet-scan — no secret / pre-network guards", () => {
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/ufc-wallet-scan/route")
    POST = mod.POST as any
  })

  it("400s on malformed JSON", async () => {
    expect((await POST(req(null, true))).status).toBe(400)
  })
  it("400s when the wallet is not 0x-prefixed", async () => {
    expect((await POST(req({ wallet: "curry" }))).status).toBe(400)
  })
  it("500s when INGEST_SECRET_TOKEN is unconfigured (valid 0x wallet)", async () => {
    const res = await POST(req({ wallet: "0xbd94cade097e50ac" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("INGEST_SECRET_TOKEN not configured")
  })
})

describe("POST /api/ufc-wallet-scan — secret configured (success path)", () => {
  const TOKEN = "ufc-scan-token"
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    // scan-ufc-wallet (GET) + enrich-ufc-wallet (POST) both resolve OK; the
    // first enrich chunk reports done:true, so no background drain is scheduled.
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ scanned: 5, total: 5, totalEnriched: 5, done: true }),
    })) as any
    const mod = await import("@/app/api/ufc-wallet-scan/route")
    POST = mod.POST as any
  })

  it("still 400s when the wallet is not 0x-prefixed", async () => {
    expect((await POST(req({ wallet: "curry" }))).status).toBe(400)
  })

  it("200-accepts a valid 0x wallet and reports the scan/enrich totals", async () => {
    const res = await POST(req({ wallet: "0xbd94cade097e50ac" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.done).toBe(true)
    expect(body.scanned).toBe(5)
    expect(body.enrichedSoFar).toBe(5)
  })
})
