import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"

// Deep-drive of GET /api/seed-wallet-refresh — the 6h orchestrator that fans
// the seeded-wallet herd out to /api/wallet-backfill-multicollection. Pins the
// dispatch policy that the DBSAT and Vercel-cost incidents were about:
//   - healthy cached wallets dispatch with skip_cached=true (diff walk only);
//   - a truncation-signature cache count (24/50/100...) forces a FULL walk;
//   - username-only rows resolve via GQL, persist the address, then force-walk;
//   - the low-priority interval gate skips recently-walked discovered-herd
//     wallets but never gates high-priority or never-walked rows;
//   - cohort splitting (?cohort=K&of=N) selects by id-modulo; invalid params 400.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

process.env.INGEST_SECRET_TOKEN = "seed-token"

const { GET } = await import("@/app/api/seed-wallet-refresh/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(qs = ""): NextRequest {
  return new NextRequest(`https://orchestrator.test/api/seed-wallet-refresh${qs}`, {
    method: "GET",
    headers: new Headers({ authorization: "Bearer seed-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function seeded(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    username: "collector",
    wallet_address: "0x1111111111111111",
    display_name: null,
    tags: null,
    priority: 1,
    last_refreshed_at: null,
    last_refreshed_per_collection: null,
    cached_moment_count: 500,
    ...over,
  }
}

function dispatchBodies(f: ReturnType<typeof installFetchMock>) {
  return f.calls
    .filter((c) => c.url.includes("/api/wallet-backfill-multicollection"))
    .map((c) => JSON.parse(String(c.init?.body)) as { wallet: string; skip_cached: boolean })
}

const backfillOk: FetchStub = {
  match: (url) => url.includes("/api/wallet-backfill-multicollection"),
  respond: () => ({ status: 202, json: { accepted: true } }),
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "seed-token"
  // See api-seed-wallet-refresh.test.ts: without this the 12h wave gate short-
  // circuits every assertion below to an empty dispatch, clock-dependently.
  process.env.SEED_WALLET_REFRESH_EVERY_WAVE = "1"
  process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
  state.afterCbs.length = 0
  fetchMock = installFetchMock([backfillOk, jsonRoute("ts-proxy.test", { data: null })])
})

describe("seed-wallet-refresh — dispatch policy", () => {
  it("dispatches healthy wallets with skip_cached=true and truncation-signature wallets with a forced full walk", async () => {
    install({
      seeded_wallets: {
        data: [
          seeded({ id: 1, username: "healthy", wallet_address: "0x1111111111111111", cached_moment_count: 500 }),
          // 24 is the wallet-search default-limit truncation marker.
          seeded({ id: 2, username: "truncated", wallet_address: "0x2222222222222222", cached_moment_count: 24 }),
        ],
        error: null,
      },
    })

    const res = await GET(req())
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
    await runDeferred()

    const bodies = dispatchBodies(fetchMock!)
    expect(bodies).toHaveLength(2)
    const byWallet = Object.fromEntries(bodies.map((b) => [b.wallet, b.skip_cached]))
    expect(byWallet["0x1111111111111111"]).toBe(true) // diff walk
    expect(byWallet["0x2222222222222222"]).toBe(false) // forced full re-walk
  })

  it("resolves a username-only row via GQL, persists the address, and forces a full walk", async () => {
    fetchMock?.restore()
    fetchMock = installFetchMock([
      backfillOk,
      jsonRoute("ts-proxy.test", {
        data: { getUserByFlowHandle: { flowAddress: "0x3333333333333333" } },
      }),
    ])
    const spy = install({
      seeded_wallets: {
        data: [seeded({ id: 3, username: "handle-only", wallet_address: null })],
        error: null,
      },
    })

    await GET(req())
    await runDeferred()

    // Address persisted back onto the seeded row.
    const update = spy.writes.seeded_wallets?.find((w) => w.method === "update")
    expect(update?.rows[0]).toMatchObject({ wallet_address: "0x3333333333333333" })
    // The backfill fired as a forced full walk for a freshly-resolved wallet.
    const bodies = dispatchBodies(fetchMock)
    expect(bodies).toEqual([{ wallet: "0x3333333333333333", skip_cached: false }])
  })

  it("a failed username resolution dispatches nothing and writes nothing", async () => {
    const spy = install({
      seeded_wallets: {
        data: [seeded({ id: 3, username: "ghost", wallet_address: null })],
        error: null,
      },
    })

    await GET(req())
    await runDeferred()

    expect(dispatchBodies(fetchMock!)).toHaveLength(0)
    expect(spy.writes.seeded_wallets ?? []).toHaveLength(0)
  })
})

describe("seed-wallet-refresh — backstop freshness gate (?force=1)", () => {
  // The GHA backstop fires ?force=1 and, because GitHub does not honour its
  // schedule, can land right after a primary wave (2026-08-30: 08:38Z slot ran
  // at 13:58Z, re-dispatching 120 wallets the 12/13Z wave had just walked). A
  // forced wave must skip wallets walked within SEED_REFRESH_BACKSTOP_FRESH_HOURS,
  // judged by the per-collection stamp (written on EVERY child run), while an
  // unforced primary wave ignores the gate entirely.
  const oneHourAgo = () => new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
  const fiveHoursAgo = () => new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()

  it("forced wave skips wallets walked within the fresh window, whatever their priority", async () => {
    install({
      seeded_wallets: {
        data: [
          // High priority, per-collection stamp 1h old -> skipped on a forced wave.
          seeded({ id: 1, username: "highpri-fresh", wallet_address: "0x1111111111111111", priority: 1, last_refreshed_at: fiveHoursAgo(), last_refreshed_per_collection: { nfl_all_day: oneHourAgo() } }),
          // Stale everywhere -> still refreshed (this is what a backstop is for).
          seeded({ id: 2, username: "highpri-stale", wallet_address: "0x2222222222222222", priority: 1, last_refreshed_at: fiveHoursAgo(), last_refreshed_per_collection: { nfl_all_day: fiveHoursAgo() } }),
          // Never walked -> refreshed.
          seeded({ id: 3, username: "never", wallet_address: "0x3333333333333333", priority: 1, last_refreshed_at: null, last_refreshed_per_collection: null }),
          // Fresh but truncation-signature count -> repair bypasses the gate.
          seeded({ id: 4, username: "fresh-truncated", wallet_address: "0x4444444444444444", priority: 1, last_refreshed_at: oneHourAgo(), cached_moment_count: 24 }),
        ],
        error: null,
      },
    })

    await GET(req("?force=1"))
    await runDeferred()

    const wallets = dispatchBodies(fetchMock!).map((b) => b.wallet).sort()
    expect(wallets).toEqual(["0x2222222222222222", "0x3333333333333333", "0x4444444444444444"])
  })

  it("an unforced primary wave does not apply the backstop gate", async () => {
    install({
      seeded_wallets: {
        data: [
          seeded({ id: 1, username: "highpri-fresh", wallet_address: "0x1111111111111111", priority: 1, last_refreshed_at: oneHourAgo(), last_refreshed_per_collection: { nfl_all_day: oneHourAgo() } }),
        ],
        error: null,
      },
    })

    await GET(req())
    await runDeferred()

    expect(dispatchBodies(fetchMock!).map((b) => b.wallet)).toEqual(["0x1111111111111111"])
  })

  it("SEED_REFRESH_BACKSTOP_FRESH_HOURS=0 disables the gate", async () => {
    // The constant is read at module load, so this pins the env contract via a
    // fresh import rather than the shared module instance.
    vi.resetModules()
    process.env.SEED_REFRESH_BACKSTOP_FRESH_HOURS = "0"
    try {
      const { GET: GET0 } = await import("@/app/api/seed-wallet-refresh/route")
      install({
        seeded_wallets: {
          data: [
            seeded({ id: 1, username: "highpri-fresh", wallet_address: "0x1111111111111111", priority: 1, last_refreshed_at: oneHourAgo(), last_refreshed_per_collection: { nfl_all_day: oneHourAgo() } }),
          ],
          error: null,
        },
      })
      await GET0(req("?force=1"))
      await runDeferred()
      expect(dispatchBodies(fetchMock!).map((b) => b.wallet)).toEqual(["0x1111111111111111"])
    } finally {
      delete process.env.SEED_REFRESH_BACKSTOP_FRESH_HOURS
      vi.resetModules()
    }
  })
})

describe("seed-wallet-refresh — low-priority interval gate", () => {
  it("skips a recently-walked low-priority wallet but keeps stale and high-priority ones", async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
    install({
      seeded_wallets: {
        data: [
          // Low priority + fresh walk -> gated out of this wave.
          seeded({ id: 1, username: "lowpri-fresh", wallet_address: "0x1111111111111111", priority: 5, last_refreshed_at: oneHourAgo }),
          // Low priority but stale past the 24h interval -> refreshed.
          seeded({ id: 2, username: "lowpri-stale", wallet_address: "0x2222222222222222", priority: 5, last_refreshed_at: thirtyHoursAgo }),
          // High priority + fresh -> ALWAYS refreshed (never gated).
          seeded({ id: 3, username: "highpri", wallet_address: "0x3333333333333333", priority: 1, last_refreshed_at: oneHourAgo }),
        ],
        error: null,
      },
    })

    await GET(req())
    await runDeferred()

    const wallets = dispatchBodies(fetchMock!).map((b) => b.wallet).sort()
    expect(wallets).toEqual(["0x2222222222222222", "0x3333333333333333"])
  })

  it("a truncation-signature count bypasses the gate even on a fresh low-priority wallet (repair first)", async () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    install({
      seeded_wallets: {
        data: [
          seeded({ id: 1, username: "lowpri-truncated", wallet_address: "0x4444444444444444", priority: 5, last_refreshed_at: oneHourAgo, cached_moment_count: 100 }),
        ],
        error: null,
      },
    })

    await GET(req())
    await runDeferred()

    expect(dispatchBodies(fetchMock!)).toEqual([{ wallet: "0x4444444444444444", skip_cached: false }])
  })
})

describe("seed-wallet-refresh — cohorts + guards", () => {
  it("?cohort=K&of=N selects the id-modulo slice only", async () => {
    install({
      seeded_wallets: {
        data: [
          seeded({ id: 10, username: "even", wallet_address: "0x1111111111111111" }),
          seeded({ id: 11, username: "odd", wallet_address: "0x2222222222222222" }),
        ],
        error: null,
      },
    })

    await GET(req("?cohort=0&of=2"))
    await runDeferred()

    expect(dispatchBodies(fetchMock!).map((b) => b.wallet)).toEqual(["0x1111111111111111"])
  })

  it("rejects invalid cohort params with 400 and unauthorized calls with 401", async () => {
    install({})
    expect((await GET(req("?cohort=2&of=2"))).status).toBe(400)
    expect((await GET(req("?cohort=0&of=9"))).status).toBe(400)
    const unauthorized = await GET(
      new NextRequest("https://t/api/seed-wallet-refresh", { method: "GET" }),
    )
    expect(unauthorized.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
