import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { POST } from "@/app/api/wallet/seed/route"

// wallet/seed is bearer-gated via x-ingest-token (INGEST_SECRET_TOKEN,
// call-time). No/blank token → 401 fail-closed before any seed work. Success
// path (2026-11-02): a valid token + walletAddress is handed to
// /api/wallet-backfill-multicollection; we stub fetch and assert the 202 envelope.

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

  it("202s and hands the wallet to the walker with the correct token (no per-collection rows of its own)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" })))
    const res = await POST(req({ token: TOKEN, body: { walletAddress: "0xBD94cade097e50AC", ownerKey: "trevor" } }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.dispatch).toBe("sent")
    expect(body.walletAddress).toBe("0xbd94cade097e50ac") // lowercased server-side
    expect(body.ownerKey).toBe("trevor")
    expect(body.results).toBeUndefined()
  })
})
