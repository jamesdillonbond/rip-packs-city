import { describe, it, expect } from "vitest"
import { anonTelemetryAllowed, TELEMETRY_IP_LIMIT_PER_HOUR, TELEMETRY_GLOBAL_LIMIT_PER_HOUR } from "@/lib/abuse/anon-rate"

// 2026-10-10 (known-issues #180 item 4): the anonymous analytics beacons spend a
// durable per-IP budget AND a global one. Pins which caps are bumped, in what
// order, and that the helper fails closed when the counter cannot be read.

type Call = { p_bucket: string; p_key: string; p_limit: number; p_window_secs: number }
function db(verdicts: Array<{ data?: unknown; error?: unknown }>) {
  const calls: Call[] = []
  return {
    calls,
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      calls.push(args as unknown as Call)
      return (verdicts.shift() ?? { data: { allowed: true, count: 1 }, error: null }) as { data: unknown; error: unknown }
    },
  }
}
const headers = (ip: string | null) => ({ get: (n: string) => (n === "x-forwarded-for" && ip ? ip : null) })

describe("anonTelemetryAllowed", () => {
  it("bumps the per-IP cap, then the global cap, and allows when both allow", async () => {
    const d = db([])
    expect(await anonTelemetryAllowed(headers("203.0.113.9"), "telemetry", d)).toBe(true)
    expect(d.calls.map((c) => [c.p_bucket, c.p_limit])).toEqual([
      ["beacon:telemetry:ip", TELEMETRY_IP_LIMIT_PER_HOUR],
      ["beacon:telemetry:global", TELEMETRY_GLOBAL_LIMIT_PER_HOUR],
    ])
    expect(d.calls[0].p_key).not.toBe("203.0.113.9") // the IP is hashed, never stored raw
  })

  it("refuses when the per-IP cap refuses, without spending the global budget", async () => {
    const d = db([{ data: { allowed: false, count: 601 }, error: null }])
    expect(await anonTelemetryAllowed(headers("203.0.113.9"), "track-funnel", d)).toBe(false)
    expect(d.calls).toHaveLength(1)
  })

  it("an IP-less request meets the global cap only", async () => {
    const d = db([])
    expect(await anonTelemetryAllowed(headers(null), "track-click", d)).toBe(true)
    expect(d.calls.map((c) => c.p_bucket)).toEqual(["beacon:track-click:global"])
  })

  it("fails CLOSED when the counter cannot be read", async () => {
    const d = db([{ data: null, error: { message: "down" } }])
    expect(await anonTelemetryAllowed(headers("203.0.113.9"), "telemetry", d)).toBe(false)
  })
})
