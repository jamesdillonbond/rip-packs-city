import { describe, it, expect } from "vitest"

// Route integration test for POST /api/public/log/empty-sniper. A logs-only
// diagnostic beacon: origin-locked (403 off-allowlist), rejects malformed JSON
// (400), and otherwise truncates fields and 204s (no DB write). Pins those three
// paths.

import { POST } from "@/app/api/public/log/empty-sniper/route"

const req = (origin: string | null, body: any, throwOnJson = false) =>
  ({
    headers: { get: (k: string) => (k === "origin" ? origin : null) },
    json: throwOnJson
      ? async () => {
          throw new Error("bad json")
        }
      : async () => body,
  }) as any

describe("POST /api/public/log/empty-sniper", () => {
  it("403s when the Origin is not on the allowlist", async () => {
    const res = await POST(req("https://evil.example.com", {}))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("origin")
  })

  it("403s when Origin is absent", async () => {
    const res = await POST(req(null, {}))
    expect(res.status).toBe(403)
  })

  it("400s on malformed JSON from an allowed origin", async () => {
    const res = await POST(req("https://www.rippackscity.com", null, true))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("json")
  })

  it("204s (no body) for a valid beacon from an allowed origin", async () => {
    const res = await POST(
      req("https://www.rippackscity.com", { ua: "iPhone", serverDealsCount: 0, visibleDealsCount: 0 }),
    )
    expect(res.status).toBe(204)
  })
})
