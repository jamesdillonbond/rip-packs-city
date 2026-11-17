import { describe, it, expect } from "vitest"
import { makeInstanceRateLimiter, clientKeyFrom } from "@/lib/http/instance-rate-limit"

// lib/http/instance-rate-limit — the bound public routes put on their EXPENSIVE
// path (R96). Pins: a sliding window (the N+1th call inside the window is refused,
// the first call after the oldest hit ages out is allowed again); refusal carries a
// whole-second Retry-After derived from the oldest hit, never 0; keys are isolated;
// the tracked-key set is bounded by eviction of the least recently seen key; and the
// key derivation prefers the platform's x-forwarded-for first hop, then x-real-ip,
// and returns NULL (do not limit) when neither exists.

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })

describe("makeInstanceRateLimiter — a sliding window per key", () => {
  it("allows `limit` calls in a window and refuses the next one with a whole-second Retry-After", () => {
    const rl = makeInstanceRateLimiter({ limit: 3, windowMs: 60_000 })
    const t0 = 1_000_000
    expect(rl.check("a", t0).allowed).toBe(true)
    expect(rl.check("a", t0 + 1_000).allowed).toBe(true)
    const third = rl.check("a", t0 + 2_000)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)
    const fourth = rl.check("a", t0 + 3_000)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
    // oldest hit at t0 expires at t0+60s; now is t0+3s → 57 s
    expect(fourth.retryAfterSeconds).toBe(57)
  })

  it("re-admits once the oldest hit leaves the window — sliding, not fixed", () => {
    const rl = makeInstanceRateLimiter({ limit: 2, windowMs: 10_000 })
    const t0 = 5_000_000
    rl.check("k", t0)
    rl.check("k", t0 + 4_000)
    expect(rl.check("k", t0 + 9_999).allowed).toBe(false)
    // t0 hit ages out at t0+10_000 (strictly older than the floor)
    expect(rl.check("k", t0 + 10_001).allowed).toBe(true)
    // now the window holds t0+4_000 and t0+10_001 → refused again until t0+14_000
    expect(rl.check("k", t0 + 12_000).allowed).toBe(false)
  })

  it("never reports Retry-After 0 on a refusal", () => {
    const rl = makeInstanceRateLimiter({ limit: 1, windowMs: 100 })
    const t0 = 42_000
    rl.check("k", t0)
    const v = rl.check("k", t0 + 99)
    expect(v.allowed).toBe(false)
    expect(v.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  it("isolates keys — one client's burst does not consume another's budget", () => {
    const rl = makeInstanceRateLimiter({ limit: 1, windowMs: 60_000 })
    const t0 = 10_000
    expect(rl.check("1.1.1.1", t0).allowed).toBe(true)
    expect(rl.check("1.1.1.1", t0 + 1).allowed).toBe(false)
    expect(rl.check("2.2.2.2", t0 + 1).allowed).toBe(true)
  })

  it("bounds the tracked-key set by evicting the least recently seen key", () => {
    const rl = makeInstanceRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 3 })
    const t0 = 0
    rl.check("a", t0)
    rl.check("b", t0 + 1)
    rl.check("c", t0 + 2)
    expect(rl.size()).toBe(3)
    rl.check("d", t0 + 3) // evicts a (least recently seen)
    expect(rl.size()).toBe(3)
    // The evicted key starts fresh (its hits are gone) — and re-adding it evicts the
    // next least recently seen key, b.
    expect(rl.check("a", t0 + 4).remaining).toBe(4)
    expect(rl.size()).toBe(3)
    // NO-CHANGE CONTROL: a surviving key keeps its hits — c has one, so 3 remain.
    expect(rl.check("c", t0 + 5).remaining).toBe(3)
  })

  it("clamps degenerate options to at least 1", () => {
    const rl = makeInstanceRateLimiter({ limit: 0, windowMs: 0 })
    const t0 = 7_000
    expect(rl.check("k", t0).allowed).toBe(true)
    expect(rl.check("k", t0).allowed).toBe(false)
  })
})

describe("clientKeyFrom — the platform's client header, or null", () => {
  it("takes the FIRST hop of x-forwarded-for", () => {
    expect(clientKeyFrom(headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" }))).toBe("203.0.113.9")
  })
  it("falls back to x-real-ip", () => {
    expect(clientKeyFrom(headers({ "x-real-ip": " 198.51.100.4 " }))).toBe("198.51.100.4")
  })
  it("returns null when no client header exists — callers must NOT share an 'unknown' bucket", () => {
    expect(clientKeyFrom(headers({}))).toBeNull()
    expect(clientKeyFrom(headers({ "x-forwarded-for": " , 10.0.0.1" }))).toBeNull()
  })
})
