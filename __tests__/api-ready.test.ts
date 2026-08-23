import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/ready (GET, no auth).
//
// ⚠ READ THIS BEFORE EDITING. The previous version of this file was GREEN for
// the entire eight days production was 500ing, because it mocked a payload the
// database does not return — `fmv_pipeline`, `data_integrity`, `sales_pipeline`,
// `listing_cache`, and `collections` as an ARRAY. The deployed `health_check()`
// returned none of those keys and returned `collections` as an object keyed by
// slug. The route called `.map()` on it, threw, and 500'd; the test passed
// because the fixture asserted the fixture's own beliefs (deep-audit R44).
//
// The lesson is pinned by the third test below, not by a comment: a payload
// whose SHAPE is wrong must produce a loud 500, never an empty per_collection
// that renders downstream as "every collection is thin". That is the only part
// of the class a unit test can hold — nothing in CI can compare a mock to the
// live function, so the route must be the thing that refuses a bad shape.

const state: { data: any; error: any } = { data: null, error: null }
const rpcCalls: string[] = []

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string) => {
      rpcCalls.push(fn)
      return { data: state.data, error: state.error }
    },
  }),
}))

import { GET } from "@/app/api/ready/route"

beforeEach(() => {
  state.data = null
  state.error = null
  rpcCalls.length = 0
})

describe("GET /api/ready", () => {
  it("500s on an RPC error without publishing the driver message", async () => {
    state.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBe("error")
    // lib/api-error.ts classifies it; Postgres's own wording must not reach anon.
    expect(JSON.stringify(body)).not.toContain("db down")
  })

  it("returns 200 with the per-collection sales slice", async () => {
    state.data = [
      { slug: "nba_top_shot", name: "NBA Top Shot", sales_24h: 3844, last_sale_at: "2026-08-23T01:58:20.531Z" },
      { slug: "disney_pinnacle", name: "Disney Pinnacle", sales_24h: 343, last_sale_at: "2026-08-23T01:26:55.480Z" },
    ]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.per_collection[0].slug).toBe("nba-top-shot")
    expect(body.per_collection[0].db_slug).toBe("nba_top_shot")
    expect(body.per_collection[0].sales_24h).toBe(3844)
    // Pinnacle's counts come from `pinnacle_sales`, not `sales`. A 0 here would
    // render "THIN-VOLUME ECOSYSTEM" on a collection trading hundreds a day.
    expect(body.per_collection[1].sales_24h).toBe(343)
  })

  it("reads the anon-safe RPC, never health_check", async () => {
    // health_check() is SECURITY DEFINER and carries user counts, telemetry and
    // db_size_mb. It must never be reachable from this anon-facing route again.
    state.data = []
    await GET()
    expect(rpcCalls).toEqual(["readiness_collection_stats"])
  })

  it("500s when the RPC returns a non-array — a shape break is not an empty market", async () => {
    // This is the exact payload health_check() returns: `collections` keyed by
    // slug. The old route reached .map() on it. Any object, and null, must be
    // an error, because rendering it as zero collections silently withdraws the
    // thin-volume caveat from every page that asks for it.
    for (const bad of [
      { nba_top_shot: { sales_24h: 3844 } },
      null,
      "ok",
      42,
    ]) {
      state.data = bad
      const res = await GET()
      expect(res.status, `payload ${JSON.stringify(bad)} must 500`).toBe(500)
      expect((await res.json()).status).toBe("error")
    }
  })

  it("emits null, not 0, for a missing count — a genuine zero must still be 0", async () => {
    state.data = [
      { slug: "ufc_strike", name: "UFC Strike", sales_24h: 0, last_sale_at: null },
      { slug: "nfl_all_day", name: "NFL All Day", last_sale_at: null },
    ]
    const res = await GET()
    const body = await res.json()
    // no-change control: a measured zero survives as a zero.
    expect(body.per_collection[0].sales_24h).toBe(0)
    // and an absent one does NOT become one.
    expect(body.per_collection[1].sales_24h).toBeNull()
  })

  it("passes thin_volume through, and an ABSENT flag is null — never false", async () => {
    // ⚠ `sales_24h` is a BOUNDED PROBE now (exact <= 10, NULL above), so it is
    // no longer comparable to a threshold and the clients read `thin_volume`.
    // An absent flag must be null, not false: `false` would assert "not thin"
    // out of a missing field — the fabricated-boolean version of `?? 0`.
    state.data = [
      { slug: "nba_top_shot", name: "NBA Top Shot", sales_24h: null, thin_volume: false, last_sale_at: null },
      { slug: "laliga_golazos", name: "LaLiga Golazos", sales_24h: 2, thin_volume: true, last_sale_at: null },
      { slug: "ufc_strike", name: "UFC Strike", sales_24h: 0, thin_volume: true, last_sale_at: null },
      { slug: "nfl_all_day", name: "NFL All Day", last_sale_at: null },
    ]
    const body = await (await GET()).json()
    expect(body.per_collection[0].thin_volume).toBe(false)
    expect(body.per_collection[0].sales_24h).toBeNull()
    expect(body.per_collection[1].thin_volume).toBe(true)
    expect(body.per_collection[1].sales_24h).toBe(2)
    // no-change control: a genuine zero is still a zero AND still thin.
    expect(body.per_collection[2].sales_24h).toBe(0)
    expect(body.per_collection[2].thin_volume).toBe(true)
    // absent flag -> null, not false
    expect(body.per_collection[3].thin_volume).toBeNull()
  })

  it("the SUCCESS path is edge-cached and the FAILURE path is NOT", async () => {
    // ⚠ The asymmetry IS the design and is easy to lose in a refactor. Success
    // carries s-maxage so an anon-hittable route stops paying ~340 disk reads
    // per request (measured 4,863 ms as postgres / 24,523 ms as anon on a QUIET
    // instance). Failure must NEVER be cached, or one transient DB blip becomes
    // a full minute of "the database is under heavy load" — the same shape as
    // /api/top-sales serving "no top sales" for five minutes (R33).
    state.data = [{ slug: "nba_top_shot", name: "NBA Top Shot", sales_24h: 1, last_sale_at: null }]
    const okRes = await GET()
    expect(okRes.status).toBe(200)
    expect(okRes.headers.get("cache-control")).toMatch(/s-maxage=\d+/)

    state.data = null
    state.error = { message: "db down" }
    const errRes = await GET()
    expect(errRes.status).toBe(500)
    expect(errRes.headers.get("cache-control")).toMatch(/no-store/)
    expect(errRes.headers.get("cache-control")).not.toMatch(/s-maxage/)
  })

  it("an empty collection list is a 200, not an error", async () => {
    state.data = []
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).per_collection).toEqual([])
  })
})
