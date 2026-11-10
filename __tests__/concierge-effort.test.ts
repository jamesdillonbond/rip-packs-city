import { describe, it, expect, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { resolveConciergeEffort, conciergeEffort, DEFAULT_CONCIERGE_EFFORT } from "@/lib/concierge/effort"

// The concierge's effort is an explicit choice (2026-11-09). A request header may
// LOWER it for A/B replays and must never raise it: an ungated header that could
// buy `high`/`max` would let any caller spend more per answer than the default.
describe("concierge effort", () => {
  const prev = process.env.CONCIERGE_EFFORT
  afterEach(() => {
    if (prev === undefined) delete process.env.CONCIERGE_EFFORT
    else process.env.CONCIERGE_EFFORT = prev
  })

  it("header lowers effort below the base", () => {
    expect(resolveConciergeEffort("medium", "high")).toBe("medium")
    expect(resolveConciergeEffort("LOW", "medium")).toBe("low")
  })

  it("header can never raise effort or pass an unknown level", () => {
    expect(resolveConciergeEffort("high", "medium")).toBe("medium")
    expect(resolveConciergeEffort("max", "high")).toBe("high")
    expect(resolveConciergeEffort("xhigh", "low")).toBe("low")
    expect(resolveConciergeEffort("garbage", "medium")).toBe("medium")
    expect(resolveConciergeEffort(null, "high")).toBe("high")
  })

  it("defaults to medium (2026-11-09 replay decision)", () => {
    delete process.env.CONCIERGE_EFFORT
    expect(DEFAULT_CONCIERGE_EFFORT).toBe("medium")
    expect(conciergeEffort()).toBe("medium")
  })

  it("env override accepts only known levels", () => {
    process.env.CONCIERGE_EFFORT = "low"
    expect(conciergeEffort()).toBe("low")
    process.env.CONCIERGE_EFFORT = "max"
    expect(conciergeEffort()).toBe(DEFAULT_CONCIERGE_EFFORT)
  })

  it("every model call in the route sends the resolved effort", () => {
    const src = readFileSync("app/api/support-chat/route.ts", "utf8")
    const calls = src.match(/anthropic\.messages\.(create|stream)\(/g) ?? []
    const sends = src.match(/output_config:\s*\{\s*effort\s*\}/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    expect(sends.length).toBe(calls.length)
  })
})
