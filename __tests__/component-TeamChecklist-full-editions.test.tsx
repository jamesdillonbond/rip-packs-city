// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import TeamChecklist from "@/components/entity/TeamChecklist"

// The "All moments" / "Full editions" toggle (Trevor 2026-09-30, replacing the
// 09-29 "Ignore parallels" grouping). Shown only when the data has parallels;
// switching reads the full-edition route, the header counts full editions, the
// URL carries ?view=full (the 09-29 ?parallels=exclude link still opens it), and
// a failed read renders the failure state — never "0 editions / $0".

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

const res = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response)

const tile = { route_slug: "1:1", player_name: "Cade Cunningham", tier: "COMMON", fmv_usd: 10, floor_usd: 8, thumbnail_url: null, owned: null }
const editionProgress = { total: 380, owned: 0, missing_count: 380, completion_pct: 0, cost_to_complete_usd: 9000, stale_missing_pct: null, wallet_cached: false, scope: "all_time", by_tier: [] }
const fullBody = {
  has_parallels: true,
  progress: { total: 213, owned: 0, locked_owned: null, missing_count: 213, completion_pct: 0, cost_to_complete_usd: 4100, unpriced_missing_count: 3, stale_missing_pct: 5, by_tier: [], wallet_cached: false, scope: "all_time" },
  editions: [{ ...tile, edition_cost_usd: 8 }],
}

function routeFetch(o: { probe: boolean | null; full: () => Promise<Response> }) {
  return vi.fn((url: string) => {
    if (url.includes("/api/profile/me")) return res(true, { user: null })
    if (url.includes("team-checklist-full-editions") && url.includes("probe=1")) return o.probe == null ? res(false, {}) : res(true, { has_parallels: o.probe })
    if (url.includes("team-checklist-full-editions")) return o.full()
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

describe("TeamChecklist full-editions toggle", () => {
  it("is hidden when the collection's data has no parallels", async () => {
    const f = routeFetch({ probe: false, full: () => res(true, fullBody) })
    vi.stubGlobal("fetch", f)
    const { getByText, queryByText } = render(<TeamChecklist collectionUrlSlug="nfl-all-day" teamSlug="x" />)
    await waitFor(() => expect(getByText("380 editions")).toBeTruthy())
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("probe=1"))).toBe(true))
    expect(queryByText("Full editions")).toBeNull()
  })

  it("switching to Full editions counts full editions, persists ?view=full, and notes unpriced editions", async () => {
    const f = routeFetch({ probe: true, full: () => res(true, fullBody) })
    vi.stubGlobal("fetch", f)
    const { getByText, findByText, queryByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await waitFor(() => expect(getByText("380 editions")).toBeTruthy())
    fireEvent.click(await findByText("Full editions"))
    await waitFor(() => expect(getByText("213 editions")).toBeTruthy())
    expect(getByText("$4,100")).toBeTruthy()
    expect(getByText(/3 unpriced editions not included/)).toBeTruthy()
    expect(getByText(/owning any parallel checks off its edition/)).toBeTruthy()
    // The play-grouping vocabulary is gone.
    expect(queryByText(/versions/)).toBeNull()
    expect(queryByText(/plays/)).toBeNull()
    expect(window.location.search).toContain("view=full")
    fireEvent.click(getByText("All moments"))
    await waitFor(() => expect(getByText("380 editions")).toBeTruthy())
    expect(window.location.search).not.toContain("view")
  })

  it("a shared ?view=full link opens in that view (toggle shown even before the probe answers)", async () => {
    window.history.replaceState(null, "", "/nba-top-shot/team/detroit-pistons?view=full")
    const f = routeFetch({ probe: null, full: () => res(true, fullBody) })
    vi.stubGlobal("fetch", f)
    const { getByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await waitFor(() => expect(getByText("213 editions")).toBeTruthy())
    expect(getByText("All moments")).toBeTruthy()
    // It never fetched the all-moments view first.
    expect(f.mock.calls.some((c) => String(c[0]).includes("team-checklist-progress"))).toBe(false)
  })

  it("the 09-29 ?parallels=exclude link still opens the full-edition view", async () => {
    window.history.replaceState(null, "", "/nba-top-shot/team/detroit-pistons?parallels=exclude")
    const f = routeFetch({ probe: true, full: () => res(true, fullBody) })
    vi.stubGlobal("fetch", f)
    const { getByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await waitFor(() => expect(getByText("213 editions")).toBeTruthy())
  })

  it("a failed full-edition read shows the failure state, not a zero header", async () => {
    window.history.replaceState(null, "", "/nba-top-shot/team/detroit-pistons?view=full")
    const f = routeFetch({ probe: true, full: () => res(false, { error: "x" }) })
    vi.stubGlobal("fetch", f)
    const { findByText, queryByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="detroit-pistons" />)
    await findByText(/Couldn.t load the checklist right now/)
    expect(queryByText(/0 editions/)).toBeNull()
    expect(queryByText("$0")).toBeNull()
  })
})
