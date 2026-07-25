import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest"

// Route integration test for POST /api/ufc-wallet-scan. Guards run pre-network:
// malformed JSON → 400, non-0x wallet → 400. The secret is captured into a
// module-level `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import, so we
// exercise BOTH regimes with vi.resetModules():
//   A. secret DELETED → a valid 0x wallet 500s ("INGEST_SECRET_TOKEN not
//      configured") before any edge-function call.
//   B. secret SET      → the scan+enrich fan-out (mocked via a stubbed global
//      fetch that reports done:true on the first enrich chunk) reaches the 200
//      { ok:true, done:true } accept; the after() drain never registers.

const cap = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { cap.fn = fn } }
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

// --- failure paths + the background enrich drain (nextStart cursor) ---

describe("POST /api/ufc-wallet-scan — failure paths + background drain", () => {
  const TOKEN = "ufc-scan-token"
  let POST: (req: any) => Promise<Response>
  // Driven per-test: scan outcome, then a queue of enrich chunk outcomes.
  const f: { scanOk: boolean; enrich: Array<any | "fail"> ; enrichCalls: number[] } = {
    scanOk: true, enrich: [], enrichCalls: [],
  }

  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    globalThis.fetch = (async (url: string, init: any) => {
      const isEnrich = String(url).includes("enrich-ufc-wallet")
      if (!isEnrich) {
        if (!f.scanOk) return { ok: false, status: 503, json: async () => ({}) }
        return { ok: true, json: async () => ({ scanned: 7, total: 7 }) }
      }
      const start = Number(new URL(String(url)).searchParams.get("start") ?? 0)
      f.enrichCalls.push(start)
      const next = f.enrich.shift()
      if (next === "fail" || next === undefined) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => next }
    }) as any
    const mod = await import("@/app/api/ufc-wallet-scan/route")
    POST = mod.POST as any
  })

  beforeEach(() => {
    f.scanOk = true
    f.enrich = []
    f.enrichCalls = []
    cap.fn = null
  })

  const wallet = () => req({ wallet: "0xbd94cade097e50ac" })

  it("502s when the scan edge function fails", async () => {
    f.scanOk = false
    const res = await POST(wallet())
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe("scan failed")
    expect(body.detail).toContain("HTTP 503")
  })

  it("200s with enrichError when the FIRST enrich chunk fails (scan still counted)", async () => {
    f.enrich = ["fail"]
    const res = await POST(wallet())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.scanned).toBe(7)
    expect(body.enrichedSoFar).toBe(0)
    expect(body.done).toBe(false)
    expect(body.enrichError).toContain("HTTP 500")
    expect(cap.fn).toBeNull() // no drain scheduled on a failed first chunk
  })

  it("schedules the drain off nextStart (NOT the enrichedSoFar count) and walks to done", async () => {
    f.enrich = [
      { totalEnriched: 100, total: 250, done: false, nextStart: 100 },
      { totalEnriched: 200, done: false, nextStart: 200 },
      { done: true },
    ]
    const res = await POST(wallet())
    const body = await res.json()
    expect(body.done).toBe(false)
    expect(body.enrichedSoFar).toBe(100)
    expect(body.totalMoments).toBe(250)

    expect(cap.fn).toBeTypeOf("function")
    await cap.fn!()
    // first call start=0 (inline), then the drain resumes at nextStart=100 then 200
    expect(f.enrichCalls).toEqual([0, 100, 200])
  })

  it("stops the drain when the cursor stalls (never advances past itself)", async () => {
    f.enrich = [
      { totalEnriched: 100, done: false, nextStart: 100 },
      { done: false, nextStart: 100 }, // same cursor → stall
      { done: true }, // must never be reached
    ]
    await POST(wallet())
    await cap.fn!()
    expect(f.enrichCalls).toEqual([0, 100])
  })

  it("stops the drain on a chunk error rather than spinning", async () => {
    f.enrich = [{ totalEnriched: 100, done: false, nextStart: 100 }, "fail"]
    await POST(wallet())
    await expect(cap.fn!()).resolves.toBeUndefined()
    expect(f.enrichCalls).toEqual([0, 100])
  })

  it("falls back to a 100 cursor when the chunk carries no usable next pointer", async () => {
    f.enrich = [{ done: false }, { done: true }] // no nextStart/next/totalEnriched
    await POST(wallet())
    await cap.fn!()
    expect(f.enrichCalls).toEqual([0, 100])
  })
})
