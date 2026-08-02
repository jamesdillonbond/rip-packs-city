// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent, act } from "@testing-library/react"
import TeamChecklist from "@/components/entity/TeamChecklist"

// Drives the public priced Team Checklist: the anonymous SEO render (checklist +
// progress fetched in parallel → "N editions" + cost-to-complete-at-floor + per-
// tier breakdown + tiles), the loading/empty states, the wallet-paste validation
// gate (0x + 16 hex), a valid paste flipping the header to Owned N/M + persisting
// to localStorage, and the scope tab re-fetch. Tracked-wallet cases keep
// wallet_cached:true so the first-paste index-warm POLLING TIMER never arms.

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

let fetchMock: ReturnType<typeof vi.fn>
const res = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response)

const tile = {
  route_slug: "damian-lillard-logo-daze",
  player_name: "Damian Lillard",
  team_name: "Portland Trail Blazers",
  set_name: "Logo Daze",
  tier: "COMMON",
  series_num: 4,
  series_label: "Series 4",
  fmv_usd: 200,
  floor_usd: 150,
  circulation_count: 1000,
  thumbnail_url: null,
  owned: false,
}
const anonProgress = {
  total: 100,
  owned: 0,
  missing_count: 100,
  completion_pct: null,
  cost_to_complete_usd: 5000,
  stale_missing_pct: null,
  wallet_cached: false,
  scope: "all_time",
  by_tier: [{ tier: "COMMON", total: 60, owned: 0, cost_usd: 1200 }],
}

// Route the parallel checklist + progress fetches. progress URL is a superset of
// the checklist path, so match "-progress" FIRST.
function routeFetch(opts: { checklist: (url: string) => Promise<Response>; progress: (url: string) => Promise<Response>; walletSearch?: () => Promise<Response> }) {
  return vi.fn((url: string, init?: any) => {
    if (url.includes("/api/wallet-search")) return (opts.walletSearch ?? (() => res(true, {})))()
    if (url.includes("team-checklist-progress")) return opts.progress(url)
    return opts.checklist(url)
  })
}

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("TeamChecklist", () => {
  it("renders the anonymous checklist: N editions, cost-to-complete, tier breakdown, tiles", async () => {
    fetchMock = routeFetch({ checklist: () => res(true, [tile]), progress: () => res(true, anonProgress) })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="portland-trail-blazers" />)
    await waitFor(() => expect(getByText("100 editions")).toBeTruthy())
    expect(getByText("Cost to complete at floor")).toBeTruthy()
    expect(getByText("$5,000")).toBeTruthy() // fmtUsd(cost_to_complete_usd)
    expect(getByText("Damian Lillard")).toBeTruthy() // tile subject
    // anonymous invites a wallet paste
    expect(getByText("Track")).toBeTruthy()
  })

  it("shows the empty-scope state when the checklist is empty", async () => {
    fetchMock = routeFetch({ checklist: () => res(true, []), progress: () => res(true, { ...anonProgress, total: 0 }) })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(getByText("No editions for this scope.")).toBeTruthy())
  })

  it("rejects an invalid wallet paste and does not set a wallet", async () => {
    fetchMock = routeFetch({ checklist: () => res(true, [tile]), progress: () => res(true, anonProgress) })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, getByPlaceholderText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(getByText("100 editions")).toBeTruthy())
    fireEvent.change(getByPlaceholderText("0x…"), { target: { value: "not-an-address" } })
    fireEvent.click(getByText("Track"))
    await waitFor(() => expect(getByText("Enter a valid 0x Flow address (0x + 16 hex).")).toBeTruthy())
    // still anonymous (no "Tracking …" chip)
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("wallet="))).toBe(true)
  })

  it("accepts a valid wallet paste: flips to Owned N/M, persists to localStorage", async () => {
    const walletProgress = { ...anonProgress, owned: 42, completion_pct: 42, wallet_cached: true }
    fetchMock = routeFetch({
      checklist: () => res(true, [tile]),
      // return the anon vs wallet progress based on whether ?wallet= is present
      progress: (url) => res(true, url.includes("wallet=") ? walletProgress : anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, getByPlaceholderText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(getByText("100 editions")).toBeTruthy())

    fireEvent.change(getByPlaceholderText("0x…"), { target: { value: "0x0123456789abcdef" } })
    fireEvent.click(getByText("Track"))

    await waitFor(() => expect(getByText("42 / 100")).toBeTruthy()) // Owned readout
    expect(getByText("Cost to complete")).toBeTruthy() // wallet variant label (no "at floor")
    expect(window.localStorage.getItem("rpc_checklist_wallet")).toBe("0x0123456789abcdef")
  })

  it("stops showing the 'Indexing' banner once the warm-up poll budget is exhausted", async () => {
    // Regression: a wallet that never warms (wallet_cached stays false) keeps the
    // indexing effect polling until MAX_INDEX_POLLS. On the exhausted run the
    // effect used to `return` WITHOUT clearing `indexing`, so the "Indexing your
    // collection" banner rendered forever (a no-exit terminal state) even after
    // the wallet finished, until a manual reload. The fix clears the flag.
    // NOTE: no RTL `waitFor` here — it polls on real timers and deadlocks under
    // fake timers. Drive every settle explicitly via act + advanceTimersByTimeAsync.
    vi.useFakeTimers()
    try {
      window.localStorage.setItem("rpc_checklist_wallet", "0x0123456789abcdef")
      fetchMock = routeFetch({
        checklist: () => res(true, [tile]),
        // Never warms → polling runs to the budget. A FRESH object per call (like the
        // real API) so each setProgress actually re-renders and re-arms the effect;
        // a shared reference would make React bail out and stall polling at one tick.
        progress: () => res(true, { ...anonProgress, wallet_cached: false }),
      })
      vi.stubGlobal("fetch", fetchMock)
      const { queryByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)

      // Settle the restore-wallet effect + initial load + the indexing effect; the
      // banner is shown while polling.
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(queryByText(/Indexing your collection/)).toBeTruthy()

      // Drive the 6-poll budget (MAX_INDEX_POLLS × INDEX_POLL_MS = 6 × 12s) to exhaustion,
      // one poll per step so React can flush the effect that schedules the next timer.
      for (let i = 0; i < 7; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
      }

      // Banner is gone — the flag no longer sticks true after the budget runs out.
      expect(queryByText(/Indexing your collection/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("switching to the Contemporary scope re-fetches with scope=contemporary", async () => {
    const checklistUrls: string[] = []
    fetchMock = routeFetch({
      checklist: (url) => { checklistUrls.push(url); return res(true, [tile]) },
      progress: () => res(true, anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(checklistUrls.length).toBe(1))
    expect(checklistUrls[0]).toContain("scope=all_time")

    fireEvent.click(getByText("Contemporary")) // Top Shot-only scope tab
    await waitFor(() => expect(checklistUrls.some((u) => u.includes("scope=contemporary"))).toBe(true))
  })
})
