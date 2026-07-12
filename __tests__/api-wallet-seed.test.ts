import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { POST } from "@/app/api/wallet/seed/route"

// wallet/seed is bearer-gated via x-ingest-token (INGEST_SECRET_TOKEN,
// call-time). No/blank token → 401 fail-closed before any seed work. Success
// path: a valid token + walletAddress walks 5 collections' getIDs scripts; we
// stub global fetch to return an empty Flow-REST id list so every collection
// resolves "empty" without any DB write, and assert the 200 accept envelope.

const saved = process.env.INGEST_SECRET_TOKEN
const TOKEN = "seed-ingest-token"

const req = (opts: { token?: string; body?: any }) => ({
  headers: new Headers(opts.token ? { "x-ingest-token": opts.token } : {}),
  json: async () => opts.body ?? {},
}) as any

beforeEach(() => { process.env.INGEST_SECRET_TOKEN = TOKEN })
afterEach(() => {
  vi.unstubAllGlobals()
  if (saved === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = saved
})

describe("POST /api/wallet/seed", () => {
  it("401s without a bearer token", async () => {
    const res = await POST({ headers: new Headers() } as any)
    expect(res.status).toBe(401)
  })

  it("401s with a wrong x-ingest-token", async () => {
    const res = await POST(req({ token: "nope", body: { walletAddress: "0xABC" } }))
    expect(res.status).toBe(401)
  })

  it("400s when walletAddress is missing", async () => {
    const res = await POST(req({ token: TOKEN, body: {} }))
    expect(res.status).toBe(400)
  })

  it("200s and reports per-collection results (all empty) with the correct token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        text: async () => btoa(JSON.stringify({ value: [] })),
      })),
    )
    const res = await POST(req({ token: TOKEN, body: { walletAddress: "0xBD94cade097e50AC", ownerKey: "trevor" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.walletAddress).toBe("0xbd94cade097e50ac") // lowercased server-side
    expect(body.ownerKey).toBe("trevor")
    expect(body.results).toHaveLength(5)
    expect(body.results.every((r: any) => r.status === "empty")).toBe(true)
  })
})
