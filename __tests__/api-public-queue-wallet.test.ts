import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for POST /api/public/queue-wallet. Validates a Flow
// address then fires the wallet-backfill orchestrator in after() (mocked to a
// no-op so no network call happens). Pins: 400 invalid_json, 400 invalid_wallet,
// 202 unavailable when INGEST_SECRET_TOKEN is unset, and 202 queued when set.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, after: (_fn: any) => {} }
})

import { POST } from "@/app/api/public/queue-wallet/route"

const BASE = "https://www.rippackscity.com/api/public/queue-wallet"
const req = (body: any, throwOnJson = false) =>
  ({
    url: BASE,
    json: throwOnJson
      ? async () => {
          throw new Error("bad json")
        }
      : async () => body,
  }) as any

let savedToken: string | undefined

beforeEach(() => {
  savedToken = process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedToken
})

describe("POST /api/public/queue-wallet", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(req(null, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_json")
  })

  it("400s on a non-Flow wallet", async () => {
    const res = await POST(req({ wallet: "0x123" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_wallet")
  })

  it("202s not-queued when the ingest token is unavailable", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(req({ wallet: "0xBD94CADE097E50AC" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.queued).toBe(false)
    expect(body.reason).toBe("unavailable")
  })

  it("202s queued for a valid wallet with the token set", async () => {
    process.env.INGEST_SECRET_TOKEN = "test-token"
    // Use a fresh wallet each run so the per-instance dedup map doesn't mark it.
    const wallet = "0xabcdef0123456789"
    const res = await POST(req({ wallet }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.queued).toBe(true)
    expect(body.wallet).toBe(wallet)
  })
})
