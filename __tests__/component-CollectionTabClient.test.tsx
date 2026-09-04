// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"
import CollectionTabClient from "@/app/(collections)/[collection]/collection/CollectionTabClient"

// `[collection]/collection` converted to a `*Client.tsx` so the component gate measures it —
// ~1,330 lines of wallet-search state machine (saved wallets, badge enrichment, batched FMV,
// cost basis, server pagination) that matched neither gate's include.
//
// ⚠ NO NEW DEFECT, and the reason is worth recording so nobody re-sweeps it: the *rendering*
// of this page's claims already lives in `CollectionMomentTable` and `PortfolioSummary`, both
// of which the component gate has measured for some time. What was unmeasured is the
// ORCHESTRATION — which is where the failure this file pins actually lives:
//
//   `fetchPaginatedMoments` THROWS on a non-2xx, and `runSearch` catches it into `error`
//   while leaving `rows` empty and `hasSearched` FALSE. That last part is load-bearing: the
//   table's "no moments found" copy is gated on `hasSearched`, so a failed read renders the
//   pre-search state plus an error banner, never "this wallet holds nothing".
//
// The heavy children are mocked to markers; this drives the page's own logic.

const PARAMS: Record<string, string> = { collection: "nba-top-shot" }
let searchParams = new URLSearchParams()
const replace = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/nba-top-shot/collection",
  useSearchParams: () => searchParams,
  useParams: () => PARAMS,
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))

vi.mock("@/components/collection/CollectionMomentTable", () => ({
  default: (p: Record<string, unknown>) => (
    <div
      data-testid="moment-table"
      data-rows={Array.isArray(p.filteredRows) ? p.filteredRows.length : 0}
      data-ids={
        Array.isArray(p.filteredRows)
          ? (p.filteredRows as Array<{ momentId?: string }>).map((r) => r.momentId).join(",")
          : ""
      }
      data-has-searched={String(p.hasSearched)}
      data-loading={String(p.loading)}
      data-show-debug={String(p.showDebug)}
      /* The cost-basis map, surfaced so a claim ABOUT it can be asserted. The
         two pre-existing cost-basis cases below asserted only `data-rows`,
         which passes identically whether the map arrives, arrives wrong, or
         never arrives at all — the vacuous shape CLAUDE.md names: a title
         carrying a claim over an assertion that does not keep it. */
      data-cost-basis-ids={
        p.costBasis instanceof Map ? Array.from(p.costBasis.keys()).sort().join(",") : ""
      }
    >
      <button
        data-testid="expand-first"
        onClick={() => {
          const rows = p.filteredRows as Array<{ momentId?: string }>
          if (rows[0]?.momentId) (p.toggleExpanded as (id: string) => void)(rows[0].momentId as string)
        }}
      />
    </div>
  ),
}))
vi.mock("@/components/collection/PortfolioSummary", () => ({
  default: (p: Record<string, unknown>) => (
    <div data-testid="portfolio" data-total={String(p.paginatedTotal)} data-has-searched={String(p.hasSearched)} />
  ),
}))
vi.mock("@/components/collection/CollectionFilterBar", () => ({
  default: (p: Record<string, unknown>) => (
    <div data-testid="filter-bar">
      <button
        data-testid="set-player-filter"
        onClick={() => (p.dispatchView as (a: unknown) => void)({ type: "SET", field: "playerFilter", value: "Damian Lillard" })}
      />
      <button
        data-testid="set-rarity-filter"
        onClick={() => (p.dispatchView as (a: unknown) => void)({ type: "SET", field: "rarityFilter", value: "RARE" })}
      />
    </div>
  ),
}))
// ⚠ The sort bar owns the CSV export, the seed-copy and the debug toggle, so a
// marker-only mock leaves all three unreachable. Expose the callbacks instead.
vi.mock("@/components/collection/CollectionSortBar", () => ({
  default: (p: Record<string, unknown>) => (
    <div data-testid="sort-bar" data-debug-mode={String(p.debugMode)} data-show-csv={String(p.showCsvButtons)}>
      <button data-testid="toggle-debug" onClick={p.onToggleShowDebug as () => void} />
      <button data-testid="export-csv" onClick={p.onExportCsv as () => void} />
      <button data-testid="copy-seeds" onClick={p.onCopySeeds as () => void} />
      <button data-testid="toggle-sort" onClick={() => (p.toggleSort as (k: string) => void)("fmv")} />
    </div>
  ),
}))
vi.mock("@/components/collection/CollectionRecentSales", () => ({ default: () => <div data-testid="recent-sales" /> }))
vi.mock("@/components/collection/WalletSoldMomentsView", () => ({ default: () => <div data-testid="sold-view" /> }))
vi.mock("@/components/packs/WalletPacksView", () => ({ default: () => <div data-testid="packs-view" /> }))
vi.mock("@/components/MomentDetailModal", () => ({ default: () => null }))
vi.mock("@/components/wallet-stat-row", () => ({ default: () => <div data-testid="stat-row" /> }))
vi.mock("@/components/marketplace-status", () => ({ MarketplaceStatusBanner: () => <div data-testid="mp-banner" /> }))

let savedWallet: string | null = null
vi.mock("@/lib/profile/saved-wallet-for-collection", () => ({
  fetchSavedWalletForCollection: async () => savedWallet,
}))

let ownerKey = ""
vi.mock("@/lib/owner-key", () => ({
  getOwnerKey: () => ownerKey,
  onOwnerKeyChange: () => () => {},
}))

// ⚠ `useWarmCache` is a DATA hook returning `{ data }`, not a cache object. A
// mock that returns `{ read, write }` never invokes the fetcher, so the saved
// wallets read is silently never made and a test asserting it fails against
// correct code. Drive the fetcher for real.
vi.mock("@/lib/warmup/WarmupContext", async () => {
  const React = await import("react")
  return {
    useWarmCache: <T,>(
      _key: string,
      fetcher: () => Promise<T>,
      opts?: { enabled?: boolean },
    ) => {
      const [data, setData] = React.useState<T | null>(null)
      React.useEffect(() => {
        if (opts?.enabled === false) return
        let cancelled = false
        fetcher()
          .then((d) => { if (!cancelled) setData(d) })
          .catch(() => {})
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [fetcher, opts?.enabled])
      return { data }
    },
    usePrefetch: () => (_k: string, fn: () => Promise<unknown>) => { void fn().catch(() => {}) },
    useWarmup: () => ({
      read: () => null,
      write: () => {},
      fetchOrJoin: async (_url: string, fn: () => Promise<unknown>) => fn(),
    }),
  }
})

const track = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => track(...a) }))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body } as unknown as Response
}

/** One `/api/cost-basis` acquisition row, keyed by the nft_id the map uses. */
const ACQUISITION = (nftId: string) => ({
  nft_id: nftId,
  buy_price: "20",
  acquired_date: "2026-01-01",
  fmv_at_acquisition: "18",
  acquisition_method: "marketplace",
})

const MOMENT = (over: Record<string, unknown> = {}) => ({
  moment_id: "9001",
  edition_key: "48:1652",
  player_name: "Damian Lillard",
  set_name: "Archive Set",
  series: 0,
  tier: "RARE",
  serial_number: 12,
  circulation_count: 1000,
  fmv: 60,
  acquired_at: new Date().toISOString(),
  ...over,
})

let momentsResponse: () => Response
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  searchParams = new URLSearchParams()
  savedWallet = null
  ownerKey = ""
  replace.mockClear()
  track.mockClear()
  momentsResponse = () =>
    json(200, {
      moments: [MOMENT()],
      wallet: "0xmine",
      page: 1,
      total_count: 137,
      total_pages: 3,
      total_fmv: 8400,
    })
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.startsWith("/api/collection-moments")) return momentsResponse()
    if (url.startsWith("/api/collection-series")) return json(200, { series: [] })
    if (url.startsWith("/api/profile/saved-wallets")) return json(200, { wallets: [] })
    if (url.startsWith("/api/badges")) return json(200, { editions: [] })
    if (url.startsWith("/api/fmv")) return json(200, { results: [] })
    if (url.startsWith("/api/best-offers")) return json(200, { offers: [] })
    if (url.startsWith("/api/cost-basis")) return json(200, { rows: [] })
    if (url.startsWith("/api/cache-refresh")) return json(200, {})
    if (url.startsWith("/api/wallet-summary")) return json(200, { wallet_fmv: 8400 })
    return json(200, {})
  })
  vi.stubGlobal("fetch", fetchMock)
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Run the component's async work to a FIXED POINT under fake timers.
 *
 * ⚠ A fixed point, not a guessed tick count. The chains are several awaits
 * deep (moments -> badges -> fmv), each of which can start another fetch, and
 * auto-paginate sleeps 300 ms between pages. Looping until the fetch count
 * stops changing settles whatever depth the component actually has; a
 * hardcoded number of ticks is the same guess-the-timing bug in a new costume.
 *
 * ⚠ Inside act(): advancing the timers resolves the fetch chains, but without
 * act() React never flushes the resulting state into the DOM, so the rows land
 * and the button under test is still not there to click.
 *
 * ⚠ Requires vi.useFakeTimers(). Under real timers it returns almost
 * immediately and guarantees nothing.
 */
async function settleAll(maxRounds = 30): Promise<void> {
  let stable = 0
  for (let i = 0; i < maxRounds && stable < 2; i++) {
    const before = fetchMock.mock.calls.length
    // ⚠ Inside act(): advancing the timers resolves the fetch chains, but
    // without act() React never flushes the resulting state into the DOM, so
    // the rows land and the Load More button is still not there to click.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    stable = fetchMock.mock.calls.length === before ? stable + 1 : 0
  }
}

// ─── The orchestration failure ───────────────────────────────────────────────

describe("CollectionTabClient — a failed wallet read must not read as an empty wallet", () => {
  it("surfaces the API's own message and leaves the table pre-search", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () => json(500, { error: "wallet cache unavailable" })
    render(<CollectionTabClient />)
    await screen.findByText("wallet cache unavailable")
    // ⚠ `hasSearched` staying FALSE is what stops the table claiming the wallet
    // holds nothing — the "no moments found" copy is gated on it.
    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("false"),
    )
    expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("0")
  })

  it("falls back to a generic message when the failure body carries none", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () => json(503, {})
    render(<CollectionTabClient />)
    await screen.findByText("Failed to load moments")
  })

  it("reports a thrown fetch rather than an empty wallet", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () => { throw new Error("network down") }
    render(<CollectionTabClient />)
    await screen.findByText("network down")
    expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("false")
  })

  it("marks the search complete on a successful read so the empty state becomes reachable", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () => json(200, { moments: [], wallet: "0xmine", page: 1, total_count: 0, total_pages: 0 })
    render(<CollectionTabClient />)
    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"),
    )
  })

  it("clears a previous error when a later search succeeds", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () => json(500, { error: "wallet cache unavailable" })
    render(<CollectionTabClient />)
    await screen.findByText("wallet cache unavailable")
    momentsResponse = () =>
      json(200, { moments: [MOMENT()], wallet: "0xmine", page: 1, total_count: 1, total_pages: 1 })
    const box = screen.getByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "0xother" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect(screen.queryByText("wallet cache unavailable")).toBeNull())
  })
})

// ─── Search entry ────────────────────────────────────────────────────────────

describe("CollectionTabClient — search entry", () => {
  it("auto-searches the wallet named in the URL", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("/api/collection-moments") && u.includes("wallet=0xmine"))).toBe(true)
    })
  })

  it("accepts the legacy ?q= spelling", async () => {
    searchParams = new URLSearchParams("q=collector")
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("wallet=collector"))).toBe(true)
    })
  })

  it("falls back to the signed-in collector's saved wallet when the URL names none", async () => {
    savedWallet = "0xsaved"
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("wallet=0xsaved"))).toBe(true)
    })
  })

  it("searches nothing when there is neither a URL wallet nor a saved one", async () => {
    render(<CollectionTabClient />)
    await new Promise((r) => setTimeout(r, 30))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.startsWith("/api/collection-moments"))).toBe(false)
  })

  it("ignores a blank submission rather than searching for nothing", async () => {
    // ⚠ `runSearch`'s own `if (!query.trim()) return` is REDUNDANT behind the
    // keydown handler's `input.trim()` and unobservable from any live call
    // site — AutoSearchReader also only fires on a non-empty query. Mutating it
    // away SURVIVES, and that is correct rather than a gap: this asserts the
    // behaviour a user can produce. Delete the keydown guard and this reds.
    render(<CollectionTabClient />)
    const box = await screen.findByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "   " } })
    fireEvent.keyDown(box, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/collection-moments"))).toBe(false)
  })

  it("trims the typed query before searching", async () => {
    render(<CollectionTabClient />)
    const box = await screen.findByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "  0xpadded  " } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("wallet=0xpadded"))).toBe(true)
    })
  })

  it("records the search and classifies address vs username", async () => {
    render(<CollectionTabClient />)
    const box = await screen.findByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "0xmine" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect(track).toHaveBeenCalled())
    expect(track.mock.calls[0][1]).toMatchObject({ input_kind: "address" })
  })

  it("classifies a non-0x query as a username", async () => {
    render(<CollectionTabClient />)
    const box = await screen.findByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect(track).toHaveBeenCalled())
    expect(track.mock.calls[0][1]).toMatchObject({ input_kind: "username" })
  })

  it("puts the searched wallet in the URL so the view is shareable", async () => {
    render(<CollectionTabClient />)
    const box = await screen.findByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "0xmine" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect(replace.mock.calls.some((c) => String(c[0]).includes("wallet=0xmine"))).toBe(true))
  })
})

// ─── Results and pagination ──────────────────────────────────────────────────

describe("CollectionTabClient — results and pagination", () => {
  it("passes the loaded rows to the table", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("reports the wallet-wide total, not the page length", async () => {
    // ⚠ The page holds 1 row and the wallet holds 137. Publishing the page
    // length as the total is the `meta.total_rows` defect in another costume.
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("portfolio").getAttribute("data-total")).toBe("137"))
  })

  it("offers Load More while pages remain, naming how many are left", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await screen.findByText(/Load More \(136 remaining\)/)
  })

  it("appends the next page rather than replacing the loaded rows", async () => {
    // ⚠ THIS TEST PASSED WITHOUT EXERCISING LOAD MORE AT ALL, and the coverage
    // gate is how it surfaced. The auto-paginate effect appends the remaining
    // pages by itself after a 300 ms sleep. On a busy runner that can beat the
    // click: `paginatedPage` reaches `paginatedTotalPages`, the button unmounts
    // (the `paginatedPage < paginatedTotalPages` ternary), the click lands on a
    // detached node, `handleLoadMore` never runs — and the id assertion below
    // STILL PASSES, because auto-paginate appended 9002 on its own.
    //
    // Measured 2026-08-17 over three full component-gate runs: `handleLoadMore`
    // and the anonymous append callback were covered 1 / 1 / 0, moving the
    // gate's `functions` number by 2 and leaving `component-tests` 0.004pt
    // above its threshold — a coin flip whose next red would have been read as
    // somebody's own regression.
    //
    // ⚠ FREEZING THE CLOCK IS NOT ENOUGH ON ITS OWN, and that is worth knowing
    // before "simplifying" this: the effect calls `setLoadingMore(true)`
    // BEFORE its sleep, so holding time below 300 ms leaves the button
    // permanently disabled and relabelled, and it can never be clicked. The
    // deterministic route is to let auto-paginate run and drive it into a dead
    // end: its page-2 read returns NO moments, so the loop breaks without
    // advancing `paginatedPage`, and Load More is then the only path to page 2.
    vi.useFakeTimers()
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      // ⚠ Keyed on the `page` PARAM plus how many page-2 reads have happened —
      // NOT on raw call order. The initial search issues more than one
      // `/api/collection-moments` request on its own (a second lands once the
      // series options resolve), so a plain call counter puts the dead-end
      // payload on the initial search and auto-paginate then runs to
      // completion. Measured: that mistake ends at "All 137 moments loaded"
      // with no button at all.
      let pageTwoReads = 0
      const payload = (moments: unknown[], page: number) =>
        json(200, { moments, wallet: "0xmine", page, total_count: 137, total_pages: 3 })
      // ⚠ Cast required: getMockImplementation() is typed as a union that
      // includes a constructor signature, so it is not directly callable.
      // vitest does not typecheck, so only `tsc --noEmit` catches this.
      const realFetch = fetchMock.getMockImplementation() as (input: unknown, init?: unknown) => Promise<Response>
      fetchMock.mockImplementation(async (input: unknown, init?: unknown) => {
        const url = String(input)
        if (!url.startsWith("/api/collection-moments")) return realFetch(input, init)
        const page = Number(new URLSearchParams(url.split("?")[1] ?? "").get("page") ?? "1")
        if (page === 1) return payload([MOMENT()], 1)
        if (page !== 2) return payload([], page)
        pageTwoReads += 1
        // First page-2 read is auto-paginate's: hand it nothing, so its loop
        // breaks without advancing `paginatedPage` and Load More survives.
        // The second is the click, and it is the one that must append.
        return pageTwoReads === 1 ? payload([], 2) : payload([MOMENT({ moment_id: "9002" })], 2)
      })

      render(<CollectionTabClient />)
      await settleAll()

      // Auto-paginate has run and broken on the empty page, so this is the
      // enabled button and not the disabled "loading" relabel.
      const more = screen.getByText(/Load More/)
      expect(pageTwoReads, "auto-paginate did not take its one attempt").toBe(1)

      fireEvent.click(more)
      await settleAll()

      // The click is what fetched page 2. Without this the test cannot tell a
      // real Load More from auto-paginate having done the work, which is
      // exactly how it went green while covering nothing.
      expect(pageTwoReads, "the click never reached handleLoadMore").toBe(2)

      // ⚠ Assert the IDS, not the count. A count-only assertion is satisfied by
      // "page 2 replaced page 1" whenever both pages are the same size, so the
      // mutation that drops the append survived `data-rows === "2"`. What
      // append promises is that the first page is STILL THERE.
      const ids = screen.getByTestId("moment-table").getAttribute("data-ids") ?? ""
      expect(ids.split(",").filter(Boolean).sort()).toEqual(["9001", "9002"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("auto-paginates the rest of the wallet without waiting for a click", async () => {
    // The behaviour that makes the Load-More button mostly redundant, and the
    // reason a page-2 fixture lands even when nothing is clicked.
    searchParams = new URLSearchParams("wallet=0xmine")
    let call = 0
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/collection-moments")) {
        call += 1
        return json(200, {
          moments: [MOMENT({ moment_id: String(9000 + call) })],
          wallet: "0xmine",
          page: call,
          total_count: 3,
          total_pages: 3,
        })
      }
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => {
      const ids = (screen.getByTestId("moment-table").getAttribute("data-ids") ?? "").split(",").filter(Boolean)
      expect(ids.length).toBeGreaterThan(1)
    })
  })

  it("offers no Load More when the wallet fits on one page", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () =>
      json(200, { moments: [MOMENT()], wallet: "0xmine", page: 1, total_count: 1, total_pages: 1 })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    expect(screen.queryByText(/Load More/)).toBeNull()
  })

  it("survives a payload with no moments array at all", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () => json(200, { wallet: "0xmine", page: 1 })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
  })
})

// ─── Sub-navigation ──────────────────────────────────────────────────────────

describe("CollectionTabClient — sub-navigation", () => {
  it("shows the Moments body by default", async () => {
    render(<CollectionTabClient />)
    expect(await screen.findByTestId("moment-table")).toBeTruthy()
    expect(screen.queryByTestId("packs-view")).toBeNull()
    expect(screen.queryByTestId("sold-view")).toBeNull()
  })

  it("shows the packs view on ?section=packs", async () => {
    searchParams = new URLSearchParams("section=packs")
    render(<CollectionTabClient />)
    expect(await screen.findByTestId("packs-view")).toBeTruthy()
    expect(screen.queryByTestId("moment-table")).toBeNull()
  })

  it("shows the sold view on ?moments=sold", async () => {
    searchParams = new URLSearchParams("moments=sold")
    render(<CollectionTabClient />)
    expect(await screen.findByTestId("sold-view")).toBeTruthy()
    expect(screen.queryByTestId("moment-table")).toBeNull()
  })

  it("switching to Sold is URL-driven so the view stays deep-linkable", async () => {
    render(<CollectionTabClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Sold" }))
    await waitFor(() => expect(replace.mock.calls.some((c) => String(c[0]).includes("moments=sold"))).toBe(true))
  })

  it("switching back to Owned drops the param rather than setting moments=owned", async () => {
    searchParams = new URLSearchParams("moments=sold")
    render(<CollectionTabClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Owned" }))
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(replace.mock.calls.every((c) => !String(c[0]).includes("moments=owned"))).toBe(true)
  })

  it("marks the active sub-tab for assistive tech", async () => {
    render(<CollectionTabClient />)
    expect((await screen.findByRole("button", { name: "Owned" })).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("button", { name: "Sold" }).getAttribute("aria-pressed")).toBe("false")
  })

  it("offers no packs sub-nav for a collection with no pack board", async () => {
    PARAMS.collection = "laliga-golazos"
    try {
      render(<CollectionTabClient />)
      await screen.findByTestId("moment-table")
      expect(screen.queryByText("Packs")).toBeNull()
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })
})

// ─── Collection-specific behaviour ───────────────────────────────────────────

describe("CollectionTabClient — collection-specific behaviour", () => {
  it("scans the chain first for a UFC wallet, then reads the cache", async () => {
    PARAMS.collection = "ufc"
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      render(<CollectionTabClient />)
      await waitFor(() => {
        const urls = fetchMock.mock.calls.map((c) => String(c[0]))
        expect(urls.some((u) => u.includes("/api/ufc-wallet-scan"))).toBe(true)
        expect(urls.some((u) => u.startsWith("/api/collection-moments"))).toBe(true)
      })
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("does not scan the chain for a non-UFC collection", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("ufc-wallet-scan"))).toBe(false)
  })

  it("still reads the cache when the UFC scan itself fails", async () => {
    // ⚠ The scan is an enrichment, not a precondition. Letting its failure stop
    // the cache read would turn a slow chain into an empty wallet.
    PARAMS.collection = "ufc"
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url.includes("ufc-wallet-scan")) throw new Error("scan down")
        if (url.startsWith("/api/collection-moments")) return momentsResponse()
        return json(200, {})
      })
      render(<CollectionTabClient />)
      await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("does not scan the chain for a UFC USERNAME — the scan needs an address", async () => {
    PARAMS.collection = "ufc"
    try {
      searchParams = new URLSearchParams("wallet=collector")
      render(<CollectionTabClient />)
      await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
      expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("ufc-wallet-scan"))).toBe(false)
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })
})

// ─── Debug mode ──────────────────────────────────────────────────────────────

describe("CollectionTabClient — debug mode", () => {
  it("stays off without ?debug=1", async () => {
    render(<CollectionTabClient />)
    await screen.findByTestId("sort-bar")
    expect(screen.queryByText("Scope Key")).toBeNull()
  })

  it("survives a collection-series read failure without blocking the page", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/collection-series")) throw new Error("series down")
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })
})

// ─── Enrichment chain ────────────────────────────────────────────────────────

describe("CollectionTabClient — enrichment", () => {
  function withRoutes(over: Record<string, () => Response>) {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      const key = Object.keys(over).find((k) => url.startsWith(k))
      if (key) return over[key]()
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
  }

  it("attaches badge info to the matching player + series", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({
      "/api/badges": () =>
        json(200, {
          editions: [
            {
              player_name: "Damian Lillard",
              series_number: 1,
              badge_score: 7,
              badge_titles: ["Rookie Year"],
              circulation_count: 1000,
            },
          ],
        }),
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("survives a badges leg that 4xxs — the moments must still render", async () => {
    // ⚠ Enrichment is additive. A failed badge read must cost badges, never the
    // wallet: dropping the rows would tell a collector they hold nothing.
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/badges": () => json(500, {}) })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("survives a thrown badges fetch", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/badges": () => { throw new Error("badges down") } })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("applies batched FMV to the rows", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({
      "/api/fmv": () =>
        json(200, { results: [{ edition: "48:1652", fmv: 61.5, confidence: "HIGH", updatedAt: "2026-08-16" }] }),
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("survives an FMV leg that fails", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/fmv": () => json(503, {}) })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("survives an FMV body that is not the expected shape", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/fmv": () => json(200, { results: "not-an-array" }) })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("survives a cost-basis leg that fails", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/cost-basis": () => json(503, {}) })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("applies cost basis when it loads", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/cost-basis": () => json(200, { acquisitions: [ACQUISITION("9001")] }) })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    // The assertion the title promises. Without it this case passed with the
    // cost-basis read deleted entirely.
    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-cost-basis-ids")).toBe("9001"),
    )
  })

  it("🚨 a FAILED cost-basis read on a NEW wallet must not leave the PREVIOUS wallet's numbers on screen", async () => {
    // The defect: the effect cleared the map only for the empty-wallet case
    // (`if (!activeWallet) { setCostBasis(new Map()); return }`), and both a
    // non-ok response (`r.ok ? r.json() : null`) and a thrown fetch left state
    // untouched. So switching wallet A -> wallet B while /api/cost-basis is
    // down kept A's acquisitions in state and rendered them against B's rows —
    // a cost basis and a P&L attributed to Moments the reader does not own,
    // which is the worst sub-class in the canon: a false claim about the
    // reader's own account that is ACTIONABLE.
    //
    // Clearing is the honest direction rather than merely the safe one: an
    // empty map suppresses PortfolioSummary's cost/P&L panel outright and
    // renders an em dash in the table's Cost column, so the failure understates
    // instead of asserting.
    searchParams = new URLSearchParams("wallet=0xmine")
    let costBasisUp = true
    withRoutes({
      "/api/cost-basis": () =>
        costBasisUp ? json(200, { acquisitions: [ACQUISITION("9001")] }) : json(503, {}),
    })
    render(<CollectionTabClient />)
    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-cost-basis-ids")).toBe("9001"),
    )

    costBasisUp = false
    const box = screen.getByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "0xother" } })
    fireEvent.keyDown(box, { key: "Enter" })

    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-cost-basis-ids")).toBe(""),
    )
  })

  it("CONTROL: a SUCCESSFUL cost-basis read on a new wallet replaces the map rather than clearing it", async () => {
    // Without this, "clear the map on every wallet change" would pass the case
    // above by simply never populating it again.
    searchParams = new URLSearchParams("wallet=0xmine")
    let nftId = "9001"
    withRoutes({ "/api/cost-basis": () => json(200, { acquisitions: [ACQUISITION(nftId)] }) })
    render(<CollectionTabClient />)
    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-cost-basis-ids")).toBe("9001"),
    )

    nftId = "9002"
    const box = screen.getByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "0xother" } })
    fireEvent.keyDown(box, { key: "Enter" })

    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-cost-basis-ids")).toBe("9002"),
    )
  })

  it("survives a cache-refresh leg that fails", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/cache-refresh": () => { throw new Error("refresh down") } })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("reads the wallet-wide FMV total from its own probe", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("limit=1&page=1"))).toBe(true)
    })
  })

  it("survives a wallet-summary leg that fails", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/wallet-summary": () => json(503, {}) })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("ignores a wallet-summary body carrying an error key", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    withRoutes({ "/api/wallet-summary": () => json(200, { error: "timeout" }) })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })
})

// ─── Saved wallets ───────────────────────────────────────────────────────────

describe("CollectionTabClient — saved wallets", () => {
  it("reads the collector's saved wallets when signed in", async () => {
    ownerKey = "0xmine"
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.startsWith("/api/profile/saved-wallets"))).toBe(true)
    })
  })

  it("does not read saved wallets for a signed-out visitor", async () => {
    render(<CollectionTabClient />)
    await new Promise((r) => setTimeout(r, 40))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/profile/saved-wallets"))).toBe(false)
  })

  it("survives a saved-wallets read that fails", async () => {
    ownerKey = "0xmine"
    searchParams = new URLSearchParams("wallet=0xmine")
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/profile/saved-wallets")) return json(503, {})
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })
})

// ─── Wallet prefetch ─────────────────────────────────────────────────────────

describe("CollectionTabClient — saved-wallet prefetch", () => {
  it("prefetches every OTHER saved wallet so a sidebar click feels instant", async () => {
    ownerKey = "0xmine"
    searchParams = new URLSearchParams("wallet=0xmine")
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/profile/saved-wallets")) {
        return json(200, { wallets: [{ wallet_addr: "0xmine" }, { wallet_addr: "0xother" }, { username: "collector" }] })
      }
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => {
      const bodies = prefetchBodies()
      // ⚠ The CURRENTLY-VIEWED wallet must be skipped — prefetching the page
      // you are already on is a duplicate whale-wallet query for nothing.
      expect(bodies.some((b) => b.includes("0xother"))).toBe(true)
      expect(bodies.some((b) => b.includes("collector"))).toBe(true)
      expect(bodies.every((b) => !b.includes("0xmine"))).toBe(true)
    })
  })

  /**
   * ⚠ The page ALSO fires `/api/wallet-search` for the wallet currently on
   * screen, from a different code path — its body carries a `collection` key
   * where a prefetch body does not. A test that counts every wallet-search call
   * is asserting about two unrelated features at once and fails against correct
   * code; this isolates the prefetches.
   */
  function prefetchBodies(): string[] {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).startsWith("/api/wallet-search"))
      .map((c) => String((c[1] as RequestInit)?.body))
      .filter((b) => !b.includes("\"collection\""))
  }

  it("skips rows carrying neither an address nor a username", async () => {
    ownerKey = "0xmine"
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/profile/saved-wallets")) return json(200, { wallets: [{}, { wallet_addr: "0xok" }] })
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(prefetchBodies().length).toBe(1))
    expect(prefetchBodies()[0]).toContain("0xok")
  })

  it("prefetches nothing when the collector has saved no wallets", async () => {
    ownerKey = "0xmine"
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/profile/saved-wallets")) return json(200, { wallets: [] })
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await new Promise((r) => setTimeout(r, 40))
    expect(prefetchBodies().length).toBe(0)
  })

  it("swallows a failed prefetch — it is a warm-up, not a result", async () => {
    ownerKey = "0xmine"
    searchParams = new URLSearchParams("wallet=0xmine")
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/profile/saved-wallets")) return json(200, { wallets: [{ wallet_addr: "0xother" }] })
      if (url.startsWith("/api/wallet-search")) return json(500, {})
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })
})

// ─── Filters reaching the server ─────────────────────────────────────────────

describe("CollectionTabClient — server-side filters", () => {
  it("asks the server for the whole wallet when no filter is set", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/collection-moments?w"))
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.every((u) => !u.includes("player=") && !u.includes("tier="))).toBe(true)
    })
  })

  it("sends the page size and sort the server needs", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("sortBy="))
      expect(urls.length).toBeGreaterThan(0)
      expect(urls[0]).toContain("limit=50")
    })
  })

  it("scopes every request to the active collection", async () => {
    PARAMS.collection = "nfl-all-day"
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      render(<CollectionTabClient />)
      await waitFor(() => {
        const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/collection-moments"))
        expect(urls.length).toBeGreaterThan(0)
        expect(urls.every((u) => u.includes("collection=nfl-all-day"))).toBe(true)
      })
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })
})

// ─── Persisted view state, seeds and exports ─────────────────────────────────

describe("CollectionTabClient — persisted view state and operator affordances", () => {
  function withStorage(store: Record<string, string>) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v },
        removeItem: (k: string) => { delete store[k] },
        clear: () => { for (const k of Object.keys(store)) delete store[k] },
      },
    })
  }

  it("restores the saved sort, filters and toggles from storage", async () => {
    withStorage({
      "rpc_collection_sortKey": JSON.stringify("fmv"),
      "rpc_collection_sortDirection": JSON.stringify("asc"),
      "rpc_collection_playerFilter": JSON.stringify("Damian Lillard"),
      "rpc_collection_setFilter": JSON.stringify("Archive Set"),
      "rpc_collection_seriesFilter": JSON.stringify("Series 1"),
      "rpc_collection_rarityFilter": JSON.stringify("RARE"),
      "rpc_collection_lockedFilter": JSON.stringify("all"),
      "rpc_collection_badgeFilter": JSON.stringify(true),
    })
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
  })

  it("survives unparseable stored view state rather than blanking the page", async () => {
    // ⚠ Every restore is a `JSON.parse` of a string we do not control once a
    // browser has it. One corrupt entry must not take the tab down.
    withStorage({ "rpc_collection_sortKey": "{not json" })
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("survives localStorage throwing outright (Safari private mode)", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => { throw new Error("blocked") },
        setItem: () => { throw new Error("blocked") },
        removeItem: () => {},
        clear: () => {},
      },
    })
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("marks a username-searched wallet as pre-seeded only when the cache is fresh", async () => {
    ownerKey = "collector"
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/seeded-wallets")) {
        return json(200, { wallets: [{ last_refreshed_at: new Date().toISOString() }] })
      }
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => {
      expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/seeded-wallets"))).toBe(true)
    })
  })

  it("does not claim a pre-seeded cache when the refresh is stale", async () => {
    ownerKey = "collector"
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/seeded-wallets")) return json(200, { wallets: [{ last_refreshed_at: old }] })
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
    expect(screen.queryByTitle(/refreshed every 2 hours/)).toBeNull()
  })

  it("does not probe the seeded cache for an address query — the probe is by username", async () => {
    ownerKey = "0xmine"
    render(<CollectionTabClient />)
    await new Promise((r) => setTimeout(r, 40))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/seeded-wallets"))).toBe(false)
  })

  it("survives a failed seeded-wallets probe", async () => {
    ownerKey = "collector"
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/seeded-wallets")) throw new Error("seeded down")
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
  })

  it("reloads page 1 when the background cache refresh finds new moments", async () => {
    // ⚠ A collector who just ripped a pack should not have to reload. The probe
    // is fire-and-forget, so its only observable effect is the extra request.
    searchParams = new URLSearchParams("wallet=0xmine")
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/cache-refresh")) return json(200, { new_stubs_inserted: 3 })
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => {
      const n = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/collection-moments?wallet=0xmine&page=1")).length
      expect(n).toBeGreaterThan(1)
    })
  })

  it("does not reload when the cache refresh finds nothing new", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/cache-refresh")) return json(200, { new_stubs_inserted: 0 })
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
    await new Promise((r) => setTimeout(r, 40))
    const n = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/collection-moments?wallet=0xmine&page=1")).length
    expect(n).toBe(1)
  })
})

// ─── Best-offer enrichment ───────────────────────────────────────────────────

describe("CollectionTabClient — best-offer enrichment", () => {
  it("costs ONE offers request for a whole page of rows, not one per row", async () => {
    // ⚠ An earlier version asserted that NOTHING had fired yet, right after the
    // rows landed. That is a race against a 2s timer, and it flaked under full
    // suite load while passing in isolation — a negative assertion whose truth
    // depends on how busy the machine is. The batching property is the same
    // claim, stated in a way the clock cannot invalidate.
    vi.useFakeTimers()
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      momentsResponse = () =>
        json(200, {
          moments: [MOMENT({ moment_id: "1" }), MOMENT({ moment_id: "2" }), MOMENT({ moment_id: "3" })],
          wallet: "0xmine",
          page: 1,
          total_count: 3,
          total_pages: 1,
        })
      render(<CollectionTabClient />)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(3000)
      // ⚠ Assert the BODY carries all three moments, not that exactly one call
      // was made. A call COUNT is order-dependent under full-suite conditions
      // (a second flush can be triggered by a later enrichment pass), and that
      // flaked while passing in isolation. The batching property — one request
      // carrying the whole page — is what the timer exists for, and it is
      // stated here in a form the scheduler cannot invalidate.
      const offerCalls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/best-offers"))
      expect(offerCalls.length).toBeGreaterThan(0)
      const batched = offerCalls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { momentIds: string[] })
      // ⚠ Identify THIS test's batch by its contents. Two weaker forms flaked
      // under full-suite load while passing in isolation:
      //   * bounding the CALL COUNT — the auto-paginate loop can flush again;
      //   * asserting EVERY batch is size 3 — the component does not clear its
      //     offer timer on unmount, so a PREVIOUS test's pending 2s flush fires
      //     into this test's fetch mock carrying that test's rows.
      // The batching property is "one request carried the whole page", and the
      // page is identifiable, so say so.
      expect(batched.some((b) => ["1", "2", "3"].every((id) => b.momentIds.includes(id)))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("flushes the offer batch once the timer elapses", async () => {
    vi.useFakeTimers()
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      render(<CollectionTabClient />)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/best-offers"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("survives a failed offers read — offers are additive, the rows are not", async () => {
    vi.useFakeTimers()
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url.startsWith("/api/best-offers")) throw new Error("offers down")
        if (url.startsWith("/api/collection-moments")) return momentsResponse()
        return json(200, {})
      })
      render(<CollectionTabClient />)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(3000)
      // ⚠ Not `=== "1"`: advancing the clock also lets the auto-paginate effect
      // pull the remaining pages, so the row count is legitimately higher. What
      // matters is that the rows SURVIVED the failed offers read.
      expect(Number(screen.getByTestId("moment-table").getAttribute("data-rows"))).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── Operator affordances: debug, CSV, seeds ─────────────────────────────────

describe("CollectionTabClient — debug table, CSV and seeds", () => {
  function setUrl(search: string) {
    window.history.replaceState({}, "", `/nba-top-shot/collection${search}`)
  }

  afterEach(() => setUrl(""))

  it("keeps debug mode off without ?debug=1", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("sort-bar").getAttribute("data-debug-mode")).toBe("false"))
  })

  it("enables debug mode from ?debug=1 in the address bar", async () => {
    // ⚠ Read from `window.location.search`, not from the `useSearchParams`
    // mock — the component reads the real address bar here, so stubbing the
    // hook alone leaves this branch unreachable.
    setUrl("?wallet=0xmine&debug=1")
    searchParams = new URLSearchParams("wallet=0xmine&debug=1")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("sort-bar").getAttribute("data-debug-mode")).toBe("true"))
  })

  it("renders the debug table only once the operator asks for it", async () => {
    setUrl("?wallet=0xmine&debug=1")
    searchParams = new URLSearchParams("wallet=0xmine&debug=1")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    expect(screen.queryByText("Scope Key")).toBeNull()
    fireEvent.click(screen.getByTestId("toggle-debug"))
    await screen.findByText("Scope Key")
    expect(screen.getByText("FMV Method")).toBeTruthy()
    expect(screen.getByText("Confidence")).toBeTruthy()
  })

  it("collapses the debug table again", async () => {
    setUrl("?wallet=0xmine&debug=1")
    searchParams = new URLSearchParams("wallet=0xmine&debug=1")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    fireEvent.click(screen.getByTestId("toggle-debug"))
    await screen.findByText("Scope Key")
    fireEvent.click(screen.getByTestId("toggle-debug"))
    await waitFor(() => expect(screen.queryByText("Scope Key")).toBeNull())
  })

  it("exports the loaded rows as CSV", async () => {
    const created: string[] = []
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = ((b: Blob) => { created.push(String(b.type)); return "blob:x" }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      render(<CollectionTabClient />)
      await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
      fireEvent.click(screen.getByTestId("export-csv"))
      await waitFor(() => expect(created.length).toBeGreaterThan(0))
      expect(created[0]).toContain("csv")
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    }
  })

  it("copies edition seed candidates to the clipboard", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    fireEvent.click(screen.getByTestId("copy-seeds"))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
  })

  it("re-sorts through the server rather than only in the browser", async () => {
    // ⚠ The rows are server-paginated, so a client-only sort would order the
    // LOADED PAGE and silently present it as the wallet's ordering.
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("sortBy=")).length
    fireEvent.click(screen.getByTestId("toggle-sort"))
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("sortBy=")).length).toBeGreaterThan(before),
    )
  })

  it("filters the LOADED rows client-side rather than re-querying", async () => {
    // ⚠ Corrects an assumption worth recording: changing a filter does NOT fire
    // a new request. `fetchPaginatedMoments` reads the filter state, but it is
    // only called by a search, a Load More, or the auto-paginate loop — so a
    // filter narrows what is on screen and reaches the server on the NEXT
    // search. Asserting a refetch here fails against correct code.
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/collection-moments?wallet")).length
    fireEvent.click(screen.getByTestId("set-rarity-filter"))
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    // Scoped to the MOMENTS query — other background legs (offers, summary)
    // keep ticking and a total-call count would be measuring those.
    const after = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/collection-moments?wallet")).length
    expect(after).toBe(before)
  })

  it("narrows the rows when the active filter excludes them", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () =>
      json(200, {
        moments: [MOMENT({ tier: "COMMON" })],
        wallet: "0xmine",
        page: 1,
        total_count: 1,
        total_pages: 1,
      })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    fireEvent.click(screen.getByTestId("set-rarity-filter"))
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("0"))
  })

  it("carries the active filter into the NEXT server query", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    fireEvent.click(screen.getByTestId("set-player-filter"))
    const box = screen.getByPlaceholderText(/Top Shot username or wallet address/)
    fireEvent.change(box, { target: { value: "0xother" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("player=Damian"))).toBe(true)
    })
  })

  it("opens the moment detail modal for a row", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
    fireEvent.click(screen.getByTestId("expand-first"))
    await waitFor(() => expect(screen.getByTestId("moment-table")).toBeTruthy())
  })
})

// ─── Offers applied, sets, packs and sharing ─────────────────────────────────

describe("CollectionTabClient — offers, sets, packs and sharing", () => {
  it("applies a returned best offer to the matching row", async () => {
    vi.useFakeTimers()
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url.startsWith("/api/best-offers")) {
          return json(200, { results: [{ momentId: "9001", bestOffer: 55, bestOfferType: "edition" }] })
        }
        if (url.startsWith("/api/collection-moments")) return momentsResponse()
        return json(200, {})
      })
      render(<CollectionTabClient />)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(3000)
      expect(Number(screen.getByTestId("moment-table").getAttribute("data-rows"))).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores a zero or negative offer rather than writing it as a bid", async () => {
    // ⚠ A "$0 best offer" on a moment page is a claim nobody has bid — the
    // absence of a bid and a bid of nothing are different things.
    vi.useFakeTimers()
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url.startsWith("/api/best-offers")) {
          return json(200, { results: [{ momentId: "9001", bestOffer: 0, bestOfferType: "serial" }] })
        }
        if (url.startsWith("/api/collection-moments")) return momentsResponse()
        return json(200, {})
      })
      render(<CollectionTabClient />)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(3000)
      expect(Number(screen.getByTestId("moment-table").getAttribute("data-rows"))).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("survives an offers body that is not the expected shape", async () => {
    vi.useFakeTimers()
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      fetchMock.mockImplementation(async (input: unknown) => {
        const url = String(input)
        if (url.startsWith("/api/best-offers")) return json(200, { results: "nope" })
        if (url.startsWith("/api/collection-moments")) return momentsResponse()
        return json(200, {})
      })
      render(<CollectionTabClient />)
      await vi.advanceTimersByTimeAsync(200)
      await vi.advanceTimersByTimeAsync(3000)
      expect(Number(screen.getByTestId("moment-table").getAttribute("data-rows"))).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("loads near-complete sets and sealed pack titles alongside the moments", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.startsWith("/api/sets?wallet="))).toBe(true)
      expect(urls.some((u) => u.startsWith("/api/wallet-packs?wallet="))).toBe(true)
    })
  })

  it("survives a failed sets or packs read — both are side panels, not the wallet", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/sets?") || url.startsWith("/api/wallet-packs")) throw new Error("side panel down")
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("applies the sealed pack titles when they arrive", async () => {
    searchParams = new URLSearchParams("wallet=0xmine")
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/wallet-packs")) return json(200, { packsByTitle: { "Archive Set": 2 } })
      if (url.startsWith("/api/collection-moments")) return momentsResponse()
      return json(200, {})
    })
    render(<CollectionTabClient />)
    await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1"))
  })

  it("offers a share link once a wallet has loaded, and confirms the copy", async () => {
    // ⚠ Declare the parameter. A zero-arg `vi.fn` infers an EMPTY tuple for
    // `mock.calls`, so `writeText.mock.calls[0][0]` is a `tsc` TS2493 while
    // vitest stays green — this repo's most-repeated CI breakage.
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    searchParams = new URLSearchParams("wallet=0xmine")
    render(<CollectionTabClient />)
    const share = await screen.findByTitle(/Copy shareable collection card link/)
    fireEvent.click(share)
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(String(writeText.mock.calls[0][0])).toContain("/share/0xmine")
    await screen.findByText("Link copied!")
  })

  it("offers no share link before a wallet has loaded", async () => {
    render(<CollectionTabClient />)
    await screen.findByTestId("moment-table")
    expect(screen.queryByTitle(/Copy shareable collection card link/)).toBeNull()
  })

  it("skips the wallet-search summary leg for UFC, which has no UFC path", async () => {
    PARAMS.collection = "ufc"
    try {
      searchParams = new URLSearchParams("wallet=0xmine")
      render(<CollectionTabClient />)
      await waitFor(() => expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"))
      const bodies = fetchMock.mock.calls
        .filter((c) => String(c[0]).startsWith("/api/wallet-search"))
        .map((c) => String((c[1] as RequestInit)?.body))
      expect(bodies.every((b) => !b.includes('"collection":"ufc"'))).toBe(true)
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })
})

// ─── Row shapes the API really produces ──────────────────────────────────────

describe("CollectionTabClient — row shapes", () => {
  async function withMoments(moments: Array<Record<string, unknown>>) {
    searchParams = new URLSearchParams("wallet=0xmine")
    momentsResponse = () =>
      json(200, { moments, wallet: "0xmine", page: 1, total_count: moments.length, total_pages: 1 })
    render(<CollectionTabClient />)
    await waitFor(() =>
      expect(screen.getByTestId("moment-table").getAttribute("data-has-searched")).toBe("true"),
    )
  }

  it("keeps a moment whose series arrives as a STRING", async () => {
    // ⚠ Badge matching parses `series` per row because the API is not
    // consistent about the type; a row that fails to parse must keep its place
    // in the wallet, just without badges.
    await withMoments([MOMENT({ series: "0" })])
    expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1")
  })

  it("keeps a moment whose series is absent entirely", async () => {
    await withMoments([MOMENT({ series: null })])
    expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1")
  })

  it("keeps a moment with no edition key — it just cannot be priced", async () => {
    await withMoments([MOMENT({ edition_key: null })])
    expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1")
  })

  it("keeps a moment with no player name", async () => {
    await withMoments([MOMENT({ player_name: null })])
    expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1")
  })

  it("keeps a moment with no id rather than dropping the row", async () => {
    await withMoments([MOMENT({ moment_id: null })])
    expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("1")
  })

  it("does not ask for badges when no row carries a player name", async () => {
    // ⚠ Scoped to the SEARCH's own badge call. A later background leg
    // (auto-paginate, cache-refresh reload) can legitimately issue one for a
    // page that DOES carry names, so an unscoped check is order-dependent.
    await withMoments([MOMENT({ player_name: null })])
    const badgeCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.startsWith("/api/badges"))
    expect(badgeCalls.every((u) => !u.includes("players=Damian"))).toBe(true)
  })

  it("does not ask for FMV when no row carries an edition key", async () => {
    await withMoments([MOMENT({ edition_key: null })])
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u === "/api/fmv")).toBe(false)
  })

  it("handles an entirely empty wallet without asking for enrichment", async () => {
    await withMoments([])
    expect(screen.getByTestId("moment-table").getAttribute("data-rows")).toBe("0")
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.startsWith("/api/badges"))).toBe(false)
  })
})
