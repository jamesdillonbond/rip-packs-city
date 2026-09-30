// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import TeamChecklist from "@/components/entity/TeamChecklist"

// The "All moments" / "Ignore parallels" toggle (concierge request 2026-09-29).
// Shown only when the data has parallels; switching reads the grouped route,
// the header counts PLAYS, the URL carries ?parallels=exclude, and a failed
// grouped read renders the failure state — never "0 plays / $0".

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

const res = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response)

const tile = { route_slug: "1:1", player_name: "Cade Cunningham", tier: "COMMON", fmv_usd: 10, floor_usd: 8, thumbnail_url: null, owned: null }
const editionProgress = { total: 380, owned: 0, missing_count: 380, completion_pct: 0, cost_to_complete_usd: 9000, stale_missing_pct: null, wallet_cached: false, scope: "all_time", by_tier: [] }
const playsBody = {
  has_parallels: true,
  progress: { total: 237, owned: 0, locked_owned: null, missing_count: 237, completion_pct: 0, cost_to_complete_usd: 4100, unpriced_missing_count: 3, stale_missing_pct: 5, by_tier: [], wallet_cached: false, scope: "all_time" },
  plays: [{ ...tile, play_key: "1:1", version_count: 3, owned_versions: null, play_cost_usd: 4 }],
}

function routeFetch(o: { probe: boolean | null; plays: () => Promise<Response> }) {
  return vi.fn((url: string) => {
    if (url.includes("/api/profile/me")) return res(true, { user: null })
    if (url.includes("team-checklist-plays") && url.includes("probe=1")) return o.probe == null ? res(false, {}) : res(true, { has_parallels: o.probe })
    if (url.includes("team-checklist-plays")) return o.plays()
    if (url.includes("team-checklist-progress")) return res(true, editionProgress)
    return res(true, [tile])
  })
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, "", "/nba-top-shot/team/detroit-pistons")
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TeamChecklist parallels toggle", () => {
  it("is hidden when the collection's data has no parallels", async () => {
    const f = routeFetch({ probe: false, plays: () => res(true, playsBody) })
    vi.stubGlobal("fetch", f)
    const { getByText, queryByText } = render(<TeamChecklist collectionUrlSlug="nfl-all-day" teamSlug="x" />)
    await waitFor(() => expect(getByText("380 editions")).toBeTruthy())
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("probe=1"))).toBe(true))
    expect(queryByText("Ignore parallels")).toBeNull()
  })

  it("switching to Ignore parallels counts plays, persists to the URL, and notes unpriced plays", async () => {
    const f = routeFetch({ probe: true, plays: () => res(true, playsBody) })
    vi.stubGlobal("fetch", f)
    const { getByText, findByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await waitFor(() => expect(getByText("380 editions")).toBeTruthy())
    fireEvent.click(await findByText("Ignore parallels"))
    await waitFor(() => expect(getByText("237 plays")).toBeTruthy())
    expect(getByText("$4,100")).toBeTruthy()
    expect(getByText(/3 unpriced plays not included/)).toBeTruthy()
    expect(getByText("3 versions")).toBeTruthy()
    expect(window.location.search).toContain("parallels=exclude")
    fireEvent.click(getByText("All moments"))
    await waitFor(() => expect(getByText("380 editions")).toBeTruthy())
    expect(window.location.search).not.toContain("parallels")
  })

  it("a shared ?parallels=exclude link opens in that mode (toggle shown even before the probe answers)", async () => {
    window.history.replaceState(null, "", "/nba-top-shot/team/detroit-pistons?parallels=exclude")
    const f = routeFetch({ probe: null, plays: () => res(true, playsBody) })
    vi.stubGlobal("fetch", f)
    const { getByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await waitFor(() => expect(getByText("237 plays")).toBeTruthy())
    expect(getByText("All moments")).toBeTruthy()
    // It never fetched the per-edition view first.
    expect(f.mock.calls.some((c) => String(c[0]).includes("team-checklist-progress"))).toBe(false)
  })

  it("a failed grouped read shows the failure state, not a zero header", async () => {
    window.history.replaceState(null, "", "/nba-top-shot/team/detroit-pistons?parallels=exclude")
    const f = routeFetch({ probe: true, plays: () => res(false, { error: "x" }) })
    vi.stubGlobal("fetch", f)
    const { findByText, queryByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await findByText(/Couldn.t load the checklist right now/)
    expect(queryByText(/0 plays/)).toBeNull()
    expect(queryByText("$0")).toBeNull()
  })
})
