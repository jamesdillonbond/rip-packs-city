import { describe, it, expect } from "vitest"
import { POST } from "@/app/api/wallet/seed/route"

// wallet/seed is bearer-gated (INGEST_SECRET_TOKEN, call-time). No/blank token
// → 401 fail-closed before any seed work.

describe("POST /api/wallet/seed", () => {
  it("401s without a bearer token", async () => {
    const res = await POST({ headers: new Headers() } as any)
    expect(res.status).toBe(401)
  })
})
