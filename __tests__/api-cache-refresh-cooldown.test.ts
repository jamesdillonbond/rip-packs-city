import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// GET /api/cache-refresh — the per-(wallet, collection) COOLDOWN (R98, 2026-09-18).
// The Collection tab calls this route for the VIEWED wallet on every load, and the
// route rewrites `last_seen_at` on every cached row as service_role. Pins:
//   - a wallet refreshed within the auto window (10 min) is SKIPPED: no chain read,
//     no write, `skipped: "recently_refreshed"`, unmeasured totals are null (never 0);
//   - a wallet older than the window refreshes exactly as before (the touch write lands);
//   - the manual button (refreshLocked=1) has a 60 s window, not 10 min;
//   - an INGEST bearer bypasses the cooldown;
//   - ⚠ a FAILED cooldown read refreshes anyway — a failed read is not "recent".
// Red first: every skip assertion fails against the pre-2026-09-18 route, which had
// no cooldown at all.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  ownedIds: [] as string[],
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
      if (opts.cadence.includes("getIDs")) return state.ownedIds
      throw new Error("no nft")
    },
  },
}))

process.env.INGEST_SECRET_TOKEN = "ingest-token"
const { GET } = await import("@/app/api/cache-refresh/route")

const WALLET = "0xbd94cade097e50ac"
type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function install(lastSeenAt: string | null, opts: { readError?: boolean } = {}) {
  const wmc = opts.readError
    ? { data: null, error: { message: "canceling statement due to statement timeout" } }
    : { data: lastSeenAt ? [{ moment_id: "1", last_seen_at: lastSeenAt }] : [], error: null }
  const fixtures: Fixtures = {
    wallet_moments_cache: wmc as never,
    moment_acquisitions: { data: [], error: null },
    editions: { data: [], error: null },
  }
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function get(qs: string, headers: Record<string, string> = {}) {
  return GET(new NextRequest(`https://t/api/cache-refresh?${qs}`, { headers: new Headers(headers) }))
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const secondsAgo = (s: number) => new Date(Date.now() - s * 1_000).toISOString()

beforeEach(() => {
  state.ownedIds = ["1"]
  state.fclCalls = 0
})

describe("cache-refresh cooldown — the auto path", () => {
  it("SKIPS a wallet refreshed 2 minutes ago: no chain read, no write, null totals", async () => {
    const spy = install(minutesAgo(2))
    const res = await get(`wallet=${WALLET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.skipped).toBe("recently_refreshed")
    expect(body.ok).toBe(true)
    expect(body.total_on_chain).toBeNull()
    expect(body.total_cached).toBeNull()
    expect(body.new_stubs_inserted).toBe(0)
    expect(body.retry_after_seconds).toBeGreaterThanOrEqual(1)
    expect(body.retry_after_seconds).toBeLessThanOrEqual(600)
    expect(typeof body.last_refreshed_at).toBe("string")
    expect(state.fclCalls).toBe(0)
    expect(spy.writes["wallet_moments_cache"]).toBeUndefined()
  })

  it("REFRESHES a wallet last seen 30 minutes ago — the touch write lands as before (no-change control)", async () => {
    const spy = install(minutesAgo(30))
    const res = await get(`wallet=${WALLET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.skipped).toBeUndefined()
    expect(state.fclCalls).toBeGreaterThanOrEqual(1) // the chain read happened (enrichment may add a metadata call)
    const touches = (spy.writes["wallet_moments_cache"] ?? []).filter((w) => w.method === "update")
    expect(touches.length).toBeGreaterThan(0)
    expect(touches[0].rows[0]).toHaveProperty("last_seen_at")
  })

  it("REFRESHES a wallet with no cached rows at all (nothing to be recent about)", async () => {
    install(null)
    const res = await get(`wallet=${WALLET}`)
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBeUndefined()
    expect(state.fclCalls).toBeGreaterThanOrEqual(1) // the chain read happened (enrichment may add a metadata call)
  })

  it("a FAILED cooldown read is not 'recently refreshed' — the route refreshes anyway", async () => {
    install(minutesAgo(2), { readError: true })
    const res = await get(`wallet=${WALLET}`)
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBeUndefined()
    expect(state.fclCalls).toBeGreaterThanOrEqual(1) // the chain read happened (enrichment may add a metadata call)
  })
})

describe("cache-refresh cooldown — the manual button and trusted callers", () => {
  it("refreshLocked=1 uses a 60 s window: 2 minutes old refreshes, 20 seconds old is skipped", async () => {
    install(minutesAgo(2))
    let res = await get(`wallet=${WALLET}&refreshLocked=1`)
    expect((await res.json()).skipped).toBeUndefined()
    expect(state.fclCalls).toBeGreaterThanOrEqual(1) // the chain read happened (enrichment may add a metadata call)

    state.fclCalls = 0
    install(secondsAgo(20))
    res = await get(`wallet=${WALLET}&refreshLocked=1`)
    const body = await res.json()
    expect(body.skipped).toBe("recently_refreshed")
    expect(body.retry_after_seconds).toBeLessThanOrEqual(60)
    expect(state.fclCalls).toBe(0)
  })

  it("an INGEST bearer bypasses the cooldown entirely", async () => {
    install(secondsAgo(5))
    const res = await get(`wallet=${WALLET}`, { authorization: "Bearer ingest-token" })
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBeUndefined()
    expect(state.fclCalls).toBeGreaterThanOrEqual(1) // the chain read happened (enrichment may add a metadata call)
  })

  it("a WRONG bearer is just an anonymous caller — still cooled down", async () => {
    install(secondsAgo(5))
    const res = await get(`wallet=${WALLET}`, { authorization: "Bearer nope" })
    expect((await res.json()).skipped).toBe("recently_refreshed")
    expect(state.fclCalls).toBe(0)
  })
})
