import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture, installFetchMock, jsonRoute } from "./helpers/route-harness"

// Deep test for GET /api/collection-moments — drives the row-shaping,
// thumbnail-fallback ladder, number coercion, acquisitionStats mapping,
// total-FMV / total-pages math, and the GQL player-name backfill that the
// shallow test (400 guard + empty 200 + RPC 500) never touches. A raw 0x…(18)
// wallet resolves with no network call, so only the Supabase RPC seams + (for
// the backfill case) global fetch need stubbing.

// `gqlResolve` lets a test drive the username→wallet resolver (topshotGraphql).
// Default null preserves the original behavior (empty object → no flowAddress).
const state = vi.hoisted(() => ({ sb: null as unknown, gqlResolve: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => state.gqlResolve ?? {},
}))

import { GET } from "@/app/api/collection-moments/route"
import { __resetUpstreamCircuits } from "@/lib/upstream/host-circuit"

const req = (u: string) => ({ nextUrl: new URL(u) }) as never
const WALLET = "0xbd94cade097e50ac" // 0x + 16 hex = 18 chars → resolves locally

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

beforeEach(() => {
  // ⛔ LOAD-BEARING, and it was added because its absence made three tests below
  // VACUOUS the moment the host circuit shipped. The circuit lives in module
  // scope, so a test that returns HTTP 500 from the GQL host trips it for every
  // LATER test in this file — those tests would then SKIP the fallback entirely
  // while still passing, because "skipped" and "failed" both leave player_name
  // null. They went on asserting an outcome they were no longer producing.
  // The paired defence is the `h.calls` assertion each of them now carries.
  __resetUpstreamCircuits()
  state.sb = null
  state.gqlResolve = null
})

describe("GET /api/collection-moments — row shaping", () => {
  it("coerces numeric strings, builds the edition-key thumbnail, and maps acquisitionStats", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [
            {
              moment_id: "101",
              edition_key: "3:45",
              serial_number: "5",
              fmv_usd: "42.5",
              confidence: "HIGH",
              low_ask: "11",
              player_name: "Dame",
              set_name: "Base Set",
              team_name: "Portland Trail Blazers",
              tier: "COMMON",
              series_number: "5",
              circulation_count: "15000",
              thumbnail_url: null,
              buy_price: "8.5",
              acquisition_method: "marketplace",
            },
          ],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 42.5, error: null },
      "rpc:get_acquisition_stats": {
        data: {
          breakdown: [
            { method: "marketplace", count: 1 },
            { method: "pack_pull", count: 2 },
          ],
          total_moments: 3,
          total_spent: 20,
          locked_count: 1,
        },
        error: null,
      },
    })

    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()

    const m = body.moments[0]
    expect(m.serial_number).toBe(5) // string → number
    expect(m.fmv_usd).toBe(42.5)
    expect(m.low_ask).toBe(11)
    expect(m.circulation_count).toBe(15000)
    expect(m.buy_price).toBe(8.5)
    expect(m.thumbnail_url).toBe(
      "https://assets.nbatopshot.com/resize/editions/3_45/play45_capture_Hero_Black_2880_2880_default.jpg?width=100&quality=80",
    )
    expect(body.total_fmv).toBe(42.5)
    expect(body.total_pages).toBe(1)
    expect(body.acquisitionStats).toMatchObject({
      marketplace_count: 1,
      pack_pull_count: 2,
      total_count: 3,
      locked_count: 1,
      total_spent: 20,
    })
  })

  it("falls back to the moment-media thumbnail when there is no edition_key", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [{ moment_id: "202", edition_key: null, player_name: "Player", thumbnail_url: null }],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })

    const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
    expect(body.moments[0].thumbnail_url).toBe("https://assets.nbatopshot.com/media/202?width=256")
  })

  it("computes total_pages from total_count and the page limit", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": { data: { moments: [], total_count: 120 }, error: null },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })

    const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}&limit=50`))).json()
    expect(body.total_count).toBe(120)
    expect(body.total_pages).toBe(3) // ceil(120/50)
  })
})

describe("GET /api/collection-moments — GQL player-name backfill", () => {
  it("fills a missing player_name / set_name / tier from the Top Shot GQL fallback", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [
            { moment_id: "303", edition_key: "7:88", player_name: null, set_name: null, tier: null, thumbnail_url: "http://x" },
          ],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })

    const h = installFetchMock([
      jsonRoute("nbatopshot.com", {
        data: {
          getMintedMoment: {
            data: {
              play: { stats: { playerName: "Resolved Player", teamAtMoment: "LAL" } },
              set: { flowName: "Playoff Set" },
              tier: "RARE",
            },
          },
        },
      }),
    ])

    try {
      const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
      const m = body.moments[0]
      expect(m.player_name).toBe("Resolved Player")
      expect(m.set_name).toBe("Playoff Set")
      expect(m.tier).toBe("RARE")
      // The fallback issued exactly one GQL POST for the missing moment.
      expect(h.calls.filter((c) => c.url.includes("nbatopshot.com"))).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it("leaves the name unresolved when the GQL fallback returns an HTTP error (null-cache continue)", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [{ moment_id: "404", edition_key: "8:99", player_name: null, thumbnail_url: "http://x" }],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })
    const h = installFetchMock([jsonRoute("nbatopshot.com", { data: {} }, { status: 500 })])
    try {
      const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
      expect(body.moments[0].player_name).toBeNull()
      // ⚠ NOT redundant with the null above: a SKIPPED fallback also leaves it
      // null, so without this the test cannot tell "called and failed" from
      // "never called" — the exact vacuity the host circuit can introduce.
      expect(h.calls.filter((c) => c.url.includes("nbatopshot.com"))).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it("logs GQL errors and resolves nothing when getMintedMoment.data is null", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [{ moment_id: "505", edition_key: "9:11", player_name: null, thumbnail_url: "http://x" }],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })
    const h = installFetchMock([
      jsonRoute("nbatopshot.com", {
        errors: [{ message: "field error" }],
        data: { getMintedMoment: { data: null } },
      }),
    ])
    try {
      const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
      expect(body.moments[0].player_name).toBeNull()
      expect(h.calls.filter((c) => c.url.includes("nbatopshot.com"))).toHaveLength(1)
    } finally {
      h.restore()
    }
  })

  it("swallows a throwing GQL fetch and leaves the name unresolved", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [{ moment_id: "606", edition_key: "1:2", player_name: null, thumbnail_url: "http://x" }],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })
    const h = installFetchMock([
      {
        match: (url) => url.includes("nbatopshot.com"),
        respond: () => {
          throw new Error("network down")
        },
      },
    ])
    try {
      const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
      expect(body.moments[0].player_name).toBeNull()
      expect(h.calls.filter((c) => c.url.includes("nbatopshot.com"))).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})

describe("GET /api/collection-moments — get_acquisition_stats is DISPATCHED early, not awaited late", () => {
  // The use-site comment said "Fire get_acquisition_stats in parallel
  // (non-blocking)" while the code awaited it AFTER `await totalFmvPromise` —
  // fully sequential. Measured 6,593 ms mean over 15 calls in the 71 min to
  // 2026-08-30 05:00Z, on a route just brought to ~2 s.
  //
  // ⚠ The property is ORDER, not presence, so asserting "the rpc was called"
  // would pass in both the fixed and the broken arrangement. This records a
  // single interleaved log of rpc dispatches AND the GQL fetch: the fallback
  // runs during row-shaping, i.e. between dispatch and await, so if the RPC were
  // still sequential it would appear AFTER the fetch.
  it("dispatches the RPC before the row-shaping GQL fallback runs", async () => {
    const order: string[] = []
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [{ moment_id: "801", edition_key: "z:9", player_name: null, thumbnail_url: "http://x" }],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })
    const base = state.sb as { rpc: (n: string, a?: unknown) => Promise<unknown> }
    const baseRpc = base.rpc.bind(base)
    base.rpc = (name: string, args?: unknown) => {
      order.push("rpc:" + name)
      return baseRpc(name, args)
    }

    const h = installFetchMock([
      {
        match: (url: string) => url.includes("nbatopshot.com"),
        respond: () => {
          order.push("gql-fetch")
          return { json: { data: { getMintedMoment: { data: null } } } }
        },
      },
    ])
    try {
      await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    } finally {
      h.restore()
    }

    const acq = order.indexOf("rpc:get_acquisition_stats")
    const fetchAt = order.indexOf("gql-fetch")
    expect(acq).toBeGreaterThanOrEqual(0)
    expect(fetchAt).toBeGreaterThanOrEqual(0)
    // THE ASSERTION: dispatched before the work it is supposed to overlap with.
    expect(acq).toBeLessThan(fetchAt)
  })
})

describe("GET /api/collection-moments — the dead-host circuit", () => {
  // `public-api.nbatopshot.com` has been Cloudflare 530/1033 since 2026-08-28,
  // and 6.90% of the 1,904,686 Top Shot rows in wallet_moments_cache have a null
  // player_name — so this fallback fires on nearly every page and cannot
  // succeed. Each call carries a 6 s AbortSignal timeout.
  const twoMissing = {
    "rpc:get_wallet_moments_with_fmv": {
      data: {
        moments: [
          { moment_id: "701", edition_key: "a:1", player_name: null, thumbnail_url: "http://x" },
          { moment_id: "702", edition_key: "b:2", player_name: null, thumbnail_url: "http://x" },
        ],
        total_count: 2,
      },
      error: null,
    },
    "rpc:get_wallet_total_fmv": { data: 0, error: null },
    "rpc:get_acquisition_stats": { data: null, error: null },
  }

  it("a 5xx trips the circuit, so a LATER request skips the host entirely", async () => {
    install(twoMissing)
    const first = installFetchMock([jsonRoute("nbatopshot.com", { data: {} }, { status: 530 })])
    try {
      await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
      // Both keys were attempted in one parallel batch before the circuit was known.
      expect(first.calls.filter((c) => c.url.includes("nbatopshot.com")).length).toBeGreaterThan(0)
    } finally {
      first.restore()
    }

    install(twoMissing)
    const second = installFetchMock([jsonRoute("nbatopshot.com", { data: {} }, { status: 530 })])
    try {
      const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
      // THE POINT: zero calls, so zero 6 s waits on a user-facing request.
      expect(second.calls.filter((c) => c.url.includes("nbatopshot.com"))).toHaveLength(0)
      // And the rendered value is unchanged — skipped and failed both leave null.
      expect(body.moments[0].player_name).toBeNull()
      expect(body.moments[1].player_name).toBeNull()
    } finally {
      second.restore()
    }
  })

  it("a THROWN fetch (the 6 s timeout shape) trips the circuit too", async () => {
    // ⚠ This case was missing and mutation testing caught it: removing
    // noteUpstreamFailure from the catch block left every other test green.
    // It is the most important path — a dead host's 6 s AbortSignal timeout is
    // the expensive shape, far worse than a fast 530 — so it needs its own
    // multi-request assertion rather than riding on the 5xx one.
    install(twoMissing)
    const first = installFetchMock([
      { match: (url: string) => url.includes("nbatopshot.com"), respond: () => { throw new Error("The operation was aborted due to timeout") } },
    ])
    try {
      await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
      expect(first.calls.filter((c) => c.url.includes("nbatopshot.com")).length).toBeGreaterThan(0)
    } finally {
      first.restore()
    }

    install(twoMissing)
    const second = installFetchMock([
      { match: (url: string) => url.includes("nbatopshot.com"), respond: () => { throw new Error("The operation was aborted due to timeout") } },
    ])
    try {
      await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
      expect(second.calls.filter((c) => c.url.includes("nbatopshot.com"))).toHaveLength(0)
    } finally {
      second.restore()
    }
  })

  it("NEGATIVE CONTROL — a 4xx is about one moment id and must NOT trip the circuit", async () => {
    // Otherwise a single bad id disables enrichment for every later request.
    install(twoMissing)
    const first = installFetchMock([jsonRoute("nbatopshot.com", { data: {} }, { status: 404 })])
    try {
      await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    } finally {
      first.restore()
    }

    install(twoMissing)
    const second = installFetchMock([jsonRoute("nbatopshot.com", { data: {} }, { status: 404 })])
    try {
      await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
      expect(second.calls.filter((c) => c.url.includes("nbatopshot.com")).length).toBeGreaterThan(0)
    } finally {
      second.restore()
    }
  })

  it("a SUCCESS keeps the circuit closed, so enrichment is never self-disabling", async () => {
    install(twoMissing)
    const h = installFetchMock([
      jsonRoute("nbatopshot.com", {
        data: { getMintedMoment: { data: { play: { stats: { playerName: "Live Name" } }, set: { flowName: "S" }, tier: "RARE" } } },
      }),
    ])
    try {
      const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
      expect(body.moments[0].player_name).toBe("Live Name")
    } finally {
      h.restore()
    }

    install(twoMissing)
    const again = installFetchMock([
      jsonRoute("nbatopshot.com", {
        data: { getMintedMoment: { data: { play: { stats: { playerName: "Live Name" } }, set: { flowName: "S" }, tier: "RARE" } } },
      }),
    ])
    try {
      await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
      expect(again.calls.filter((c) => c.url.includes("nbatopshot.com")).length).toBeGreaterThan(0)
    } finally {
      again.restore()
    }
  })
})

describe("GET /api/collection-moments — username resolution + collection scoping", () => {
  it("resolves a username via GQL and scopes every RPC by the collection UUID", async () => {
    // topshotGraphql returns a bare (no-0x) flowAddress → the resolver prefixes it.
    state.gqlResolve = {
      getUserProfileByUsername: { publicInfo: { flowAddress: "aabbccddeeff0011" } },
    }
    install({
      collection_config: { data: { collection_id: "col-uuid-123" }, error: null },
      "rpc:get_wallet_moments_with_fmv": {
        data: { moments: [{ moment_id: "1", player_name: "P", thumbnail_url: "http://x" }], total_count: 1 },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 12, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })

    const res = await GET(req("https://t/api/collection-moments?wallet=cooluser&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xaabbccddeeff0011")
    expect(body.total_fmv).toBe(12)
    expect(body.total_count).toBe(1)
  })

  it("500s the outer catch when a username cannot be resolved to a wallet", async () => {
    // Default gqlResolve ({}) → no flowAddress → resolveWalletAddress throws.
    install({})
    const res = await GET(req("https://t/api/collection-moments?wallet=ghostuser"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Internal server error")
  })

  it("leaves the wallet unscoped when the collection_config lookup returns no UUID", async () => {
    install({
      collection_config: { data: null, error: null }, // no collection_id → collectionId stays null
      "rpc:get_wallet_moments_with_fmv": { data: { moments: [], total_count: 0 }, error: null },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })
    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}&collection=laliga-golazos`))
    expect(res.status).toBe(200)
    expect((await res.json()).total_count).toBe(0)
  })

  it("treats a total-FMV RPC error as $0 without failing the page", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: { moments: [{ moment_id: "1", player_name: "P", thumbnail_url: "http://x" }], total_count: 1 },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: null, error: { message: "fmv boom" } },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })
    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    expect((await res.json()).total_fmv).toBe(0)
  })
})
