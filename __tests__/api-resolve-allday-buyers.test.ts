import { describe, it, expect } from "vitest"

// Route integration test for /api/resolve-allday-buyers (GET).
// NOTE: import-only / static stub — this route was DEPRECATED 2026-05-03 and
// unconditionally returns HTTP 410 "gone" with no DB / proxy / auth seam. There
// is nothing to mock; we assert the retirement contract and that GET is wired.

import { GET } from "@/app/api/resolve-allday-buyers/route"

describe("GET /api/resolve-allday-buyers", () => {
  it("exports a GET handler", () => {
    expect(typeof GET).toBe("function")
  })

  it("410s (retired) with a gone error", async () => {
    const res = await GET()
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body.error).toBe("gone")
    expect(body.reason).toContain("resolve-allday-buyers retired")
  })
})
