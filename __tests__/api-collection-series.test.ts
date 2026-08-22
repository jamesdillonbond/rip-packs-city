import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-series. No auth. Guards on the
// collection slug (unknown → 400). Valid slug (default nba-top-shot has a
// flowContractName) resolves the collection UUID via collection_config.single(),
// then reads collection_series ordered by series_number. We mock @/lib/supabase's
// chained builder so single() yields the config row and order() yields the series.

// ⚠ The mock returns `{ data, error }` because that is what supabase-js does — it
// RETURNS errors rather than throwing. A mock that only ever yields `{ data }`
// cannot express the failure this suite exists to pin, and the route's old
// `const { data } = ...` would have passed against it forever.
const state: { config: any; configError: any; series: any; seriesError: any } = {
  config: { collection_id: "uuid-1" },
  configError: null,
  series: [],
  seriesError: null,
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: state.config, error: state.configError }),
    order: async () => ({ data: state.series, error: state.seriesError }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/collection-series/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.config = { collection_id: "uuid-1" }
  state.configError = null
  state.series = []
  state.seriesError = null
})

describe("GET /api/collection-series", () => {
  it("400s for an unknown collection slug", async () => {
    const res = await GET(req("https://t/api/collection-series?collection=not-a-collection"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns the series list for a valid collection", async () => {
    state.series = [
      { series_number: 0, display_label: "Series 1", season: null },
      { series_number: 8, display_label: "Series 2025-26", season: "25-26" },
    ]
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.series).toHaveLength(2)
    expect(body.series[0].display_label).toBe("Series 1")
  })

  it("returns an empty series list when the collection has no config row", async () => {
    // Read succeeded and found nothing — an honest empty, still 200 and still cacheable.
    state.config = null
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect((await res.json()).series).toEqual([])
  })
})

// ⚠ A FAILED READ MUST NOT RENDER AS AN ANSWER. Both reads used to swallow `error`,
// so a timeout resolved `{ data: null, error }` and fell into the `{ series: [] }`
// branch. CollectionTabClient then sets an EMPTY series filter — the page states
// "this collection has no series" out of a database timeout. The success path is
// cached `s-maxage=300, stale-while-revalidate=600`, so that claim was served to
// every visitor for up to 15 minutes from a single failure.
//
// ⚠ These assert the ABSENCE OF THE FALSE CLAIM (no 200, no empty series array),
// not the presence of any particular error copy — per CLAUDE.md, asserting the
// error message rather than the missing claim is the vacuous shape.
describe("GET /api/collection-series — a failed read is not an empty answer", () => {
  const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" }

  it("does NOT return an empty series list when the config read fails", async () => {
    state.configError = TIMEOUT
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.status).not.toBe(200)
    const body = await res.json()
    expect(body.series).toBeUndefined()
  })

  it("does NOT return an empty series list when the series read fails", async () => {
    state.seriesError = TIMEOUT
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.status).not.toBe(200)
    const body = await res.json()
    expect(body.series).toBeUndefined()
  })

  it("never caches a failure — a transient error must not be served for 15 minutes", async () => {
    // The whole reason this defect was severe is the cache on the success path.
    state.seriesError = TIMEOUT
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.headers.get("Cache-Control")).toContain("no-store")
    expect(res.headers.get("Cache-Control")).not.toContain("s-maxage")
  })

  it("does not leak the driver message to the client", async () => {
    // ⚠ FORWARD PIN, not a regression test — stated so it is not miscounted as one.
    // It passes on the pre-fix code too, because that returned `{ series: [] }` with no
    // message at all. What it catches is the tempting WRONG fix: surfacing
    // `error.message` to the client. That is the /api/sets incident — Postgres's own
    // "canceling statement due to statement timeout" rendered to anonymous visitors
    // under an ERROR heading.
    state.seriesError = TIMEOUT
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(JSON.stringify(await res.json())).not.toContain("canceling statement")
  })

  it("still caches the SUCCESS path — the fix must not disable edge caching", async () => {
    // ⚠ This one guards MY fix, not the original defect — it also passes pre-fix. The
    // lazy repair for "a failure got cached" is to drop caching entirely, which would put
    // a DB read on every collection-page load. The honest fix keeps s-maxage on success
    // and no-store on failure; this pins that split.
    state.series = [{ series_number: 0, display_label: "Series 1", season: null }]
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300")
  })
})
