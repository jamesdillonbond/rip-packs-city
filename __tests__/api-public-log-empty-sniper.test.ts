import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

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

// ⚠ The logged payload is an explicit ALLOWLIST, so a field the client sends
// but the route omits vanishes with no error — the beacon then reads as
// coverage while recording nothing. These pin the two fields that separate a
// DEGRADED build (a deal-bearing read inside /api/sniper-feed failed; the route
// still answered 200, so `fetchStatus` is "ok") from a genuinely quiet floor.
// Without them the log cannot tell the two apart, which is the whole reason
// this beacon exists.
describe("POST /api/public/log/empty-sniper — the degraded-source fields survive the allowlist", () => {
  const logged = () => {
    const line = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((l: string) => l.startsWith("[empty-sniper-beacon]"))
    if (!line) throw new Error("no beacon line logged")
    return JSON.parse(line.replace("[empty-sniper-beacon] ", ""))
  }
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(() => {}) })
  afterEach(() => { logSpy.mockRestore() })

  it("records degraded + the source labels", async () => {
    await POST(req("https://www.rippackscity.com", {
      ua: "iPhone", serverDealsCount: 0, visibleDealsCount: 0,
      degraded: true, sourcesFailed: ["allday-marketplace", "allday-fmv"],
    }))
    const p = logged()
    expect(p.degraded).toBe(true)
    expect(p.sourcesFailed).toEqual(["allday-marketplace", "allday-fmv"])
  })

  it("NO-CHANGE CONTROL: a quiet-floor beacon is not recorded as degraded", async () => {
    await POST(req("https://www.rippackscity.com", {
      ua: "iPhone", serverDealsCount: 0, visibleDealsCount: 0,
      degraded: false, sourcesFailed: [],
    }))
    const p = logged()
    expect(p.degraded).toBe(false)
    expect(p.sourcesFailed).toEqual([])
  })

  it("a beacon predating the fields is recorded as not-degraded, never as true", async () => {
    await POST(req("https://www.rippackscity.com", { ua: "iPhone", serverDealsCount: 0, visibleDealsCount: 0 }))
    const p = logged()
    expect(p.degraded).toBe(false)
    expect(p.sourcesFailed).toBeNull()
  })

  it("bounds the label list so one beacon cannot dump unbounded text into the logs", async () => {
    await POST(req("https://www.rippackscity.com", {
      ua: "iPhone", degraded: true,
      sourcesFailed: Array.from({ length: 40 }, (_, i) => "s".repeat(200) + i),
    }))
    const p = logged()
    expect(p.sourcesFailed).toHaveLength(12)
    for (const label of p.sourcesFailed) expect(label.length).toBeLessThanOrEqual(64)
  })

  it("a non-array sourcesFailed is nulled rather than logged verbatim", async () => {
    await POST(req("https://www.rippackscity.com", { ua: "iPhone", degraded: "yes", sourcesFailed: "everything" }))
    const p = logged()
    expect(p.sourcesFailed).toBeNull()
    // Only a literal `true` counts — a truthy string must not read as a failure.
    expect(p.degraded).toBe(false)
  })
})
