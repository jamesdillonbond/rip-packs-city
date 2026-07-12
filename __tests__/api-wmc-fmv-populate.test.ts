import { describe, it, expect } from "vitest"
import { POST } from "@/app/api/wmc-fmv-populate/route"

// wmc-fmv-populate is bearer-gated (module-const INGEST_SECRET_TOKEN). With no
// token configured it fails closed → 401 before any populate work.

describe("POST /api/wmc-fmv-populate", () => {
  it("401s without authorization", async () => {
    const res = await POST({ headers: new Headers(), nextUrl: new URL("https://t/api/wmc-fmv-populate") } as any)
    expect(res.status).toBe(401)
  })
})
