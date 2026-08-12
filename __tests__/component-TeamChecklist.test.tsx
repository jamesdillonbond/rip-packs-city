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

  // ── deepening: series chips, load-more, wallet clear, stale note, tri-state tiles ──

  // Build N tiles so page 0 fills PAGE_SIZE (24) → not exhausted → Load-more shows.
  const manyTiles = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({ ...tile, route_slug: `slug-${i}`, ...over }))

  it("derives series chips from the first fetch and re-fetches on a series chip", async () => {
    const urls: string[] = []
    fetchMock = routeFetch({
      checklist: (url) => { urls.push(url); return res(true, [{ ...tile, series_num: 7 }]) },
      progress: () => res(true, anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    // series_num 7 → topshot label "Series 2024-25"
    await waitFor(() => expect(getByText("Series 2024-25")).toBeTruthy())
    fireEvent.click(getByText("Series 2024-25"))
    await waitFor(() => expect(urls.some((u) => u.includes("scope=series_7"))).toBe(true))
  })

  it("loads more when a full page is returned, appending the next page", async () => {
    let call = 0
    fetchMock = routeFetch({
      checklist: () => {
        call += 1
        // page 0 → 24 rows (full), page 1 → 3 rows (short → exhausted)
        return res(true, call === 1 ? manyTiles(24) : manyTiles(3, { route_slug: "next" }))
      },
      progress: () => res(true, anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, container } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    const loadMore = await waitFor(() => getByText("Load 24 more"))
    const before = container.querySelectorAll('a[href^="/nba-top-shot/edition/"]').length
    expect(before).toBe(24)
    fireEvent.click(loadMore)
    await waitFor(() =>
      expect(container.querySelectorAll('a[href^="/nba-top-shot/edition/"]').length).toBe(27),
    )
    // short second page → button gone
    expect(container.textContent).not.toContain("Load 24 more")
  })

  it("clears a tracked wallet back to the anonymous paste form", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", "0x0123456789abcdef")
    fetchMock = routeFetch({
      checklist: () => res(true, [tile]),
      progress: (url) => res(true, url.includes("wallet=")
        ? { ...anonProgress, owned: 5, completion_pct: 5, wallet_cached: true }
        : anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, getByPlaceholderText } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(getByText("Clear")).toBeTruthy())
    fireEvent.click(getByText("Clear"))
    await waitFor(() => expect(getByPlaceholderText("0x…")).toBeTruthy())
    expect(window.localStorage.getItem("rpc_checklist_wallet")).toBeNull()
  })

  it("renders the stale-pricing note, the locked-owned readout, and per-tier owned/total", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", "0x0123456789abcdef")
    const walletProgress = {
      ...anonProgress,
      owned: 30,
      completion_pct: 30,
      locked_owned: 4,
      stale_missing_pct: 22,
      wallet_cached: true,
      by_tier: [{ tier: "COMMON", total: 60, owned: 12, cost_usd: 800 }],
    }
    fetchMock = routeFetch({
      checklist: () => res(true, [tile]),
      progress: (url) => res(true, url.includes("wallet=") ? walletProgress : anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, container } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(getByText("4 locked")).toBeTruthy())
    expect(container.textContent).toContain("stale or low-confidence pricing")
    expect(container.textContent).toContain("12/60") // per-tier owned/total (hasWallet)
    // three-state legend renders with a wallet
    expect(getByText("Owned + locked")).toBeTruthy()
  })

  it("renders the checklist tile tri-state ownership badge (owned + locked with count)", async () => {
    window.localStorage.setItem("rpc_checklist_wallet", "0x0123456789abcdef")
    const walletTiles = [
      { ...tile, route_slug: "owned-locked", owned: true, owned_locked: true, owned_count: 3, thumbnail_url: "https://x/a.png" },
      { ...tile, route_slug: "owned-plain", owned: true, owned_locked: false },
      { ...tile, route_slug: "missing", owned: false, floor_usd: 42 },
    ]
    fetchMock = routeFetch({
      checklist: () => res(true, walletTiles),
      progress: (url) => res(true, url.includes("wallet=")
        ? { ...anonProgress, owned: 2, completion_pct: 66, wallet_cached: true }
        : anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { container } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(container.querySelector('a[href*="owned-locked"]')).toBeTruthy())
    const text = container.textContent ?? ""
    expect(text).toContain("×3") // owned_count > 1
    expect(text).toContain("🔒") // locked
    expect(text).toContain("+ $42") // missing tile shows add-cost
    // owned-locked tile carried a thumbnail → an <img> rendered
    expect(container.querySelector('a[href*="owned-locked"] img')).toBeTruthy()
  })

  it("non-Top-Shot collection: no Contemporary tab, 'Series N' chip labels", async () => {
    fetchMock = routeFetch({
      checklist: () => res(true, [{ ...tile, series_num: 3 }]),
      progress: () => res(true, anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, queryByText } = render(<TeamChecklist collectionUrlSlug="nfl-all-day" teamSlug="cowboys" />)
    await waitFor(() => expect(getByText("Series 3")).toBeTruthy())
    expect(queryByText("Contemporary")).toBeNull() // Top Shot-only scope
  })

  // ── Honest failure ─────────────────────────────────────────────────────
  // This block used to contain one test asserting that a NOT-OK checklist fetch
  // "recovers to the empty state" — i.e. it pinned a 500 rendering as "No
  // editions for this scope.", a completeness claim about the team's catalogue.
  // A collector checking which moments exist for a team was told there are none.
  // The no-crash intent is kept; the claim is now what gets ruled out.

  it("does not claim the scope is empty when the checklist fetch is not ok", async () => {
    fetchMock = routeFetch({
      checklist: () => res(false, null),
      progress: () => res(true, { ...anonProgress, total: 0 }),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, container } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(getByText(/Couldn't load the checklist right now/)).toBeTruthy())
    expect(container.textContent).not.toContain("No editions for this scope.")
  })

  it("still reports a genuinely empty scope", async () => {
    // The mirror. Without it, hard-coding the failure copy would satisfy the
    // test above while destroying the real empty state.
    fetchMock = routeFetch({ checklist: () => res(true, []), progress: () => res(true, { ...anonProgress, total: 0 }) })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, container } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    await waitFor(() => expect(getByText("No editions for this scope.")).toBeTruthy())
    expect(container.textContent).not.toMatch(/Couldn't load the checklist/)
  })

  it("a failed PAGE load says the list is incomplete and KEEPS the retry", async () => {
    // The sharper half. loadMore used to set exhausted on failure, which both
    // asserts the checklist is complete AND removes the only control that could
    // retry it — so one 500 freezes a partial catalogue on screen permanently,
    // with every tile still looking correct.
    let call = 0
    fetchMock = routeFetch({
      checklist: () => {
        call += 1
        return call === 1 ? res(true, manyTiles(24)) : res(false, null)
      },
      progress: () => res(true, anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, container } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    const loadMore = await waitFor(() => getByText("Load 24 more"))
    fireEvent.click(loadMore)

    await waitFor(() => expect(getByText(/this list is incomplete/)).toBeTruthy())
    // The control survives, relabelled, so the user can actually recover.
    expect(getByText("Retry")).toBeTruthy()
    // The 24 rows already fetched are correct and stay on screen.
    expect(container.querySelectorAll('a[href^="/nba-top-shot/edition/"]').length).toBe(24)
  })

  it("clears the incomplete notice once a retry succeeds", async () => {
    let call = 0
    fetchMock = routeFetch({
      checklist: () => {
        call += 1
        if (call === 1) return res(true, manyTiles(24))
        if (call === 2) return res(false, null)
        return res(true, manyTiles(3, { route_slug: "next" }))
      },
      progress: () => res(true, anonProgress),
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByText, container } = render(<TeamChecklist collectionUrlSlug="nba-top-shot" teamSlug="blazers" />)
    fireEvent.click(await waitFor(() => getByText("Load 24 more")))
    fireEvent.click(await waitFor(() => getByText("Retry")))
    await waitFor(() =>
      expect(container.querySelectorAll('a[href^="/nba-top-shot/edition/"]').length).toBe(27),
    )
    expect(container.textContent).not.toMatch(/this list is incomplete/)
  })
})
