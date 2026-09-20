import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// GET /api/cache-refresh — the PER-CLIENT bound (R98 second half, 2026-09-19).
// The per-(wallet, collection) cooldown (api-cache-refresh-cooldown.test.ts) bounds
// repeat refreshes of ONE wallet; it says nothing about a client naming a DIFFERENT
// wallet each call, where every distinct address is a fresh full pass as service_role.
// Pins:
//   - the 13th distinct-wallet refresh from one client key inside a minute is refused
//     with 429 + Retry-After, and the refused call performs NO Supabase read at all
//     (not even the cooldown read) and NO chain read;
//   - the refusal body carries no `ok`, no totals — a bound is not a measurement;
//   - a request with NO platform client header is never limited (the helper's contract;
//     also why every other cache-refresh suite is untouched by this change);
//   - an INGEST bearer is not counted against the client key.
// Red first: against the pre-2026-09-19 route the 13th call is a 200 with a chain read.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  fclCalls: 0,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string }) => {
      state.fclCalls++
      if (opts.cadence.includes("getIDs")) return [] // an empty wallet: the cheapest full pass
      throw new Error("no nft")
    },
  },
}))

process.env.INGEST_SECRET_TOKEN = "ingest-token"
const { GET } = await import("@/app/api/cache-refresh/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function install() {
  const fixtures: Fixtures = {
    wallet_moments_cache: { data: [], error: null },
    moment_acquisitions: { data: [], error: null },
    editions: { data: [], error: null },
  }
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  // The harness records writes; a refused call must make no READ either, so count
  // every `from(table)` the route opens (each read or write begins with one).
  const counter = { from: 0 }
  const fixture = spy.fixture as { from: (table: string) => unknown }
  const baseFrom = fixture.from.bind(fixture)
  fixture.from = (table: string) => {
    counter.from++
    return baseFrom(table)
  }
  state.sb = fixture
  return { ...spy, counter }
}

function get(qs: string, headers: Record<string, string> = {}) {
  return GET(new NextRequest(`https://t/api/cache-refresh?${qs}`, { headers: new Headers(headers) }))
}

// Distinct, well-formed Flow addresses so the cooldown can never be what skips a call.
const walletN = (n: number) => "0x1" + n.toString(16).padStart(15, "0")

beforeEach(() => {
  state.fclCalls = 0
})

describe("cache-refresh per-client bound", () => {
  it("refuses the 13th distinct-wallet refresh from one client in a minute with 429 + Retry-After, before any read", async () => {
    const ip = { "x-forwarded-for": "203.0.113.77, 10.0.0.1" }
    let spy = install()
    for (let i = 1; i <= 12; i++) {
      const res = await get(`wallet=${walletN(i)}`, ip)
      expect(res.status, `call ${i} must be allowed`).toBe(200)
    }
    const chainReadsBefore = state.fclCalls
    expect(chainReadsBefore).toBeGreaterThanOrEqual(12) // positive control: the 12 allowed calls DID read the chain
    expect(spy.counter.from).toBeGreaterThanOrEqual(12) // and each opened at least the cooldown read

    spy = install() // fresh spy so the refused call's reads are counted from zero
    const res = await get(`wallet=${walletN(13)}`, ip)
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get("Retry-After"))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    const body = await res.json()
    expect(body.error).toBe("rate_limited")
    expect(body.retry_after_seconds).toBe(retryAfter)
    // A bound is not a measurement: nothing in the refusal reads as a result.
    expect(body).not.toHaveProperty("ok")
    expect(body).not.toHaveProperty("total_on_chain")
    expect(body).not.toHaveProperty("new_stubs_inserted")
    // The refused call cost nothing: no chain read, no Supabase read (not even the cooldown read).
    expect(state.fclCalls).toBe(chainReadsBefore)
    expect(spy.counter.from).toBe(0)
  })

  it("a request with no platform client header is never limited (no-change control for every other suite)", async () => {
    install()
    for (let i = 1; i <= 15; i++) {
      const res = await get(`wallet=${walletN(100 + i)}`)
      expect(res.status, `unkeyed call ${i}`).toBe(200)
    }
  })

  it("an INGEST bearer is not counted against the client key", async () => {
    const ip = { "x-forwarded-for": "198.51.100.9" }
    install()
    for (let i = 1; i <= 15; i++) {
      const res = await get(`wallet=${walletN(200 + i)}`, { ...ip, authorization: "Bearer ingest-token" })
      expect(res.status, `trusted call ${i}`).toBe(200)
    }
    // And the same client, unauthenticated, still has its full budget: the trusted calls did not spend it.
    const res = await get(`wallet=${walletN(300)}`, ip)
    expect(res.status).toBe(200)
  })
})
