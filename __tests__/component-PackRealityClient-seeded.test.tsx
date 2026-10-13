// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import PackRealityClient from "@/app/insights/pack-reality/PackRealityClient"

// Review E2 (2026-10-13): `initialData` is the FIRST FRAME only.
//   • Seeded: the KPIs render synchronously — before any fetch resolves — and
//     the mount fetch still runs and replaces the seed (the live read keeps
//     every honesty branch fed).
//   • No-change control: a null seed renders the pre-seed board ("Loading…",
//     em-dashes), so a failed server read costs nothing the board did not
//     already do.
//   • Hydration: the ranker-staleness age is anchored to `meta.fetched_at`,
//     not the clock, so the server and the browser compute ONE value.

const stats = {
  rips_60d: 69956, zero_value_rips: 22100, zero_value_pct: 31.6, mean_pull_value_usd: 5.86,
  median_pull_value_usd: 1.5, p90_pull_value_usd: 20, p99_pull_value_usd: 120,
  rips_over_100: 1028, rips_over_100_pct: 1.47, rips_over_1000: 42,
}
const seedBody = {
  meta: { fetched_at: "2026-10-13T14:00:00Z", errors: [] },
  stats,
  distribution: [{ bucket: "$0", rips: 22100, pct: 31.6 }],
  top_ev: [],
  model_vs_reality: { qualifying_dists: 0, over_modeled: [], under_modeled: [], on_model: [] },
}

function neverResolvingFetch() {
  return vi.fn(() => new Promise(() => {}))
}
function fetchOnce(payload: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe("PackRealityClient seeded first frame", () => {
  it("renders the seeded KPIs synchronously, with no Loading state, while the live fetch is still in flight", () => {
    vi.stubGlobal("fetch", neverResolvingFetch())
    render(<PackRealityClient initialData={seedBody as never} />)
    expect(screen.getAllByText("69,956").length).toBeGreaterThan(0)
    expect(screen.getAllByText("31.6%").length).toBeGreaterThan(0)
    expect(screen.queryByText("Loading…")).toBeNull()
  })
  it("no-change control: a null seed renders the pre-seed board — Loading…, em-dash KPIs", () => {
    vi.stubGlobal("fetch", neverResolvingFetch())
    render(<PackRealityClient initialData={null} />)
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0)
    expect(screen.queryByText("69,956")).toBeNull()
  })
  it("the mount fetch still runs on a seeded frame and its result replaces the seed", async () => {
    const fetchMock = fetchOnce({ ...seedBody, stats: { ...stats, rips_60d: 70001 } })
    vi.stubGlobal("fetch", fetchMock)
    render(<PackRealityClient initialData={seedBody as never} />)
    expect(screen.getAllByText("69,956").length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getAllByText("70,001").length).toBeGreaterThan(0))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("69,956")).toBeNull()
  })
  it("ranker-staleness age is anchored to meta.fetched_at, not the clock (server and browser agree)", () => {
    vi.stubGlobal("fetch", neverResolvingFetch())
    // The browser clock is set 10 DAYS after the server's read. If the age were
    // computed from Date.now(), the label would read "10 days ago"; anchored to
    // fetched_at it reads the 30 hours that separated snapshot and read.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-23T14:00:00Z"))
    const seeded = {
      ...seedBody,
      top_ev: [],
      meta: {
        fetched_at: "2026-10-13T14:00:00Z",
        errors: [],
        ranker_staleness: {
          stale_count: 2, newest_qualifying_snapshot: "2026-10-12T08:00:00Z",
          candidates_considered: 3, candidates_adjudicated: 3, verdict_complete: true,
        },
      },
    }
    render(<PackRealityClient initialData={seeded as never} />)
    expect(screen.getByText(/30 hours ago/)).toBeTruthy()
    expect(screen.queryByText(/10 days ago/)).toBeNull()
  })
})
