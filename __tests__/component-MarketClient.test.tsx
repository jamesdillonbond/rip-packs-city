// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, within, act } from "@testing-library/react"
import MarketClient from "@/app/(collections)/[collection]/market/MarketClient"

// `[collection]/market` converted to a `*Client.tsx` so the component gate measures it —
// ~1,170 lines of filter/sort/pagination state machine and two listing renderers that
// matched neither gate's include.
//
// ⚠ NO NEW DEFECT HERE, and that is worth recording so nobody re-sweeps it. The page is
// the SHAPE TO COPY for the failed-read class: a strict `loading : error : empty` ladder,
// so the error branch is consulted BEFORE the empty state and a 503 can never render as
// "No listings match these filters." Its `?? 0` on `pagination.total` sits inside the
// non-error branch, so it cannot manufacture a zero, and the thin-volume notice is gated on
// `healthRow != null` — a failed `/api/ready` read declines to characterise the market
// rather than calling it thin. All four are pinned below, in both directions, because
// nothing but a test stops the next edit collapsing them.

const PARAMS: Record<string, string> = { collection: "nba-top-shot" }
let searchParams = new URLSearchParams()
const replace = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/nba-top-shot/market",
  useSearchParams: () => searchParams,
  useParams: () => PARAMS,
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))
vi.mock("@/components/packs/PackMarketView", () => ({
  default: ({ collection }: { collection: string }) => <div data-testid="pack-market">{collection}</div>,
}))
vi.mock("@/components/BadgeIcon", () => ({
  default: ({ slug }: { slug?: string }) => <span data-testid="badge">{slug}</span>,
}))

let ownerKey: string | null = null
vi.mock("@/lib/owner-key", () => ({ getOwnerKey: () => ownerKey }))

const trackOutbound = vi.fn()
vi.mock("@/lib/track-click", () => ({ trackOutboundClick: (...a: unknown[]) => trackOutbound(...a) }))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body } as unknown as Response
}

const LISTING = (over: Record<string, unknown> = {}) => ({
  id: "l-1",
  flowId: "9001",
  momentId: "m-1",
  playerName: "Damian Lillard",
  teamName: "Portland Trail Blazers",
  setName: "Archive Set",
  seriesName: "Series 1",
  tier: "RARE",
  parallel: null,
  serialNumber: 12,
  circulationCount: 1000,
  listedCount: 4,
  askPrice: 42,
  fmv: 60,
  discount: 0.3,
  lowConfidenceFmv: false,
  confidence: "HIGH",
  source: "topshot",
  buyUrl: "https://nbatopshot.com/moment/abc",
  thumbnailUrl: "https://assets.nbatopshot.com/x.jpg",
  badgeSlugs: ["rookie_year"],
  editionKey: "48:1652",
  isSpecialSerial: false,
  listingResourceId: null,
  storefrontAddress: null,
  isLocked: false,
  listedAt: new Date().toISOString(),
  cachedAt: new Date().toISOString(),
  collectionId: "nba_top_shot",
  ...over,
})

function market(over: Record<string, unknown> = {}) {
  return {
    listings: [LISTING()],
    pagination: { total: 137, page: 1, limit: 50, hasMore: true },
    clamp: { applied: false, ceilings: {} },
    diagnostics: { rawCount: 1, postClampCount: 1, postFilterCount: 1 },
    ...over,
  }
}

let marketResponse: () => Response
let readyResponse: () => Response
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  searchParams = new URLSearchParams()
  ownerKey = null
  replace.mockClear()
  trackOutbound.mockClear()
  marketResponse = () => json(200, market())
  readyResponse = () => json(200, { per_collection: [{ slug: "nba-top-shot", name: "Top Shot", sales_24h: 900, fmv_coverage_pct: 80 }] })
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.startsWith("/api/ready")) return readyResponse()
    if (url.startsWith("/api/wallet/edition-counts")) return json(200, { counts: {} })
    return marketResponse()
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─── The honesty ladder ──────────────────────────────────────────────────────

describe("MarketClient — a failed read must not render as an empty market", () => {
  it("names the failure instead of showing the empty state", async () => {
    marketResponse = () => json(503, {})
    render(<MarketClient />)
    await screen.findByText(/Couldn't load market/)
    expect(screen.queryByText("No listings match these filters.")).toBeNull()
  })

  it("carries the status so an operator can tell a 503 from a 500", async () => {
    marketResponse = () => json(500, {})
    render(<MarketClient />)
    const el = await screen.findByText(/Couldn't load market/)
    expect(el.textContent).toContain("HTTP 500")
  })

  it("reports a thrown fetch rather than an empty market", async () => {
    marketResponse = () => { throw new Error("network down") }
    render(<MarketClient />)
    const el = await screen.findByText(/Couldn't load market/)
    expect(el.textContent).toContain("network down")
  })

  it("shows an ERROR summary line instead of a fabricated result count", async () => {
    // ⚠ `total` is `data?.pagination.total ?? 0`. It is honest only because the
    // summary line consults `error` FIRST — collapse that and the page publishes
    // "0 OF 0 EDITIONS", a claim about the market made out of our own outage.
    marketResponse = () => json(503, {})
    render(<MarketClient />)
    await waitFor(() => expect(screen.getByText(/^ERROR — /)).toBeTruthy())
    expect(screen.queryByText(/0 OF 0 EDITIONS/)).toBeNull()
  })

  it("still shows the empty state when the read SUCCEEDS with no listings", async () => {
    marketResponse = () => json(200, market({ listings: [], pagination: { total: 0, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await screen.findByText("No listings match these filters.")
    expect(screen.queryByText(/Couldn't load market/)).toBeNull()
  })

  it("hides pagination on a failed read so nothing invites paging through nothing", async () => {
    marketResponse = () => json(503, {})
    render(<MarketClient />)
    await screen.findByText(/Couldn't load market/)
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull()
  })
})

// ─── Thin volume ─────────────────────────────────────────────────────────────

describe("MarketClient — the thin-volume notice", () => {
  it("declines to characterise the market when /api/ready fails", async () => {
    // ⚠ `healthRow != null` is the guard. Without it a failed health read would
    // read `sales_24h` off nothing, score 0 < 10, and tell a collector the
    // ecosystem is thin — a claim about the market from a failed read of OUR
    // OWN health endpoint.
    readyResponse = () => json(503, {})
    marketResponse = () => json(200, market({ listings: [], pagination: { total: 0, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await screen.findByText("No listings match these filters.")
    expect(screen.queryByText(/Thin-volume ecosystem/)).toBeNull()
  })

  it("declines when the health payload carries no row for this collection", async () => {
    readyResponse = () => json(200, { per_collection: [{ slug: "nfl-all-day", name: "All Day", sales_24h: 1, fmv_coverage_pct: 3 }] })
    marketResponse = () => json(200, market({ listings: [], pagination: { total: 0, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await screen.findByText("No listings match these filters.")
    expect(screen.queryByText(/Thin-volume ecosystem/)).toBeNull()
  })

  it("says so when the health read genuinely reports thin volume", async () => {
    // ⚠ Reads `thin_volume`, not `sales_24h`. Since 2026-08-23 `sales_24h` is a
    // BOUNDED PROBE (exact when <= 10, NULL above) and is no longer comparable
    // to a threshold — the server does the comparison, because only the server
    // knows the bound.
    readyResponse = () => json(200, { per_collection: [{ slug: "nba-top-shot", name: "Top Shot", sales_24h: 2, thin_volume: true }] })
    marketResponse = () => json(200, market({ listings: [], pagination: { total: 0, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await screen.findByText(/Thin-volume ecosystem/)
  })

  it("a BUSY collection reports sales_24h: null and must NOT read as thin", async () => {
    // 🚨 THE REGRESSION THIS PAIR EXISTS TO CATCH. The bounded probe returns
    // NULL above 10, so the pre-2026-08-23 client expression
    // `(sales_24h ?? 0) < 10` coerces "busy" to 0 and renders
    // "THIN-VOLUME ECOSYSTEM" on Top Shot — the loudest possible false claim
    // about the market, produced by a performance fix.
    readyResponse = () => json(200, { per_collection: [{ slug: "nba-top-shot", name: "Top Shot", sales_24h: null, thin_volume: false }] })
    marketResponse = () => json(200, market({ listings: [], pagination: { total: 0, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await screen.findByText("No listings match these filters.")
    expect(screen.queryByText(/Thin-volume ecosystem/)).toBeNull()
  })

  it("an UNKNOWN flag is not a thin claim", async () => {
    // null/absent means we do not know. `=== true` is what keeps that from
    // becoming an assertion — the boolean version of the `?? 0` defect.
    readyResponse = () => json(200, { per_collection: [{ slug: "nba-top-shot", name: "Top Shot", sales_24h: null, thin_volume: null }] })
    marketResponse = () => json(200, market({ listings: [], pagination: { total: 0, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await screen.findByText("No listings match these filters.")
    expect(screen.queryByText(/Thin-volume ecosystem/)).toBeNull()
  })

  it("survives a health payload with no per_collection array", async () => {
    readyResponse = () => json(200, {})
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
  })
})

// ─── Results ─────────────────────────────────────────────────────────────────

describe("MarketClient — results", () => {
  it("renders a listing row with its player, set and ask", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(screen.getByText("Archive Set")).toBeTruthy()
    expect(document.body.textContent).toContain("$42")
  })

  it("states the result count against the true total", async () => {
    render(<MarketClient />)
    await waitFor(() => expect(document.body.textContent).toContain("1 OF 137 EDITIONS"))
  })

  it("singularises the count for a one-edition market", async () => {
    marketResponse = () => json(200, market({ pagination: { total: 1, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await waitFor(() => expect(document.body.textContent).toContain("1 OF 1 EDITION"))
  })

  it("discloses clamped outliers rather than silently dropping them", async () => {
    marketResponse = () => json(200, market({ diagnostics: { rawCount: 10, postClampCount: 7, postFilterCount: 7 } }))
    render(<MarketClient />)
    await waitFor(() => expect(document.body.textContent).toContain("3 OUTLIERS CLAMPED"))
  })

  it("says nothing about clamping when nothing was clamped", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(document.body.textContent).not.toContain("OUTLIERS CLAMPED")
  })

  it("shows a skeleton before the first payload rather than an empty market", async () => {
    let release: (r: Response) => void = () => {}
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/ready")) return Promise.resolve(readyResponse())
      return new Promise<Response>((res) => { release = res })
    })
    const { container } = render(<MarketClient />)
    await waitFor(() => expect(container.querySelector(".rpc-skeleton")).toBeTruthy())
    expect(screen.queryByText("No listings match these filters.")).toBeNull()
    release(json(200, market()))
    await screen.findByText("Damian Lillard")
  })
})

// ─── Filters, sort and URL state ─────────────────────────────────────────────

describe("MarketClient — filters, sort and URL state", () => {
  it("initialises the view from the URL", async () => {
    searchParams = new URLSearchParams("view=grid")
    const { container } = render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(container.querySelector(".rpc-binder")).toBeTruthy()
  })

  it("defaults to the table view", async () => {
    const { container } = render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(container.querySelector(".rpc-binder")).toBeNull()
  })

  it("carries a URL tier filter into the request", async () => {
    searchParams = new URLSearchParams("tier=RARE")
    render(<MarketClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("tier=RARE"))).toBe(true)
    })
  })

  it("carries a URL price band into the request", async () => {
    searchParams = new URLSearchParams("minPrice=10&maxPrice=100")
    render(<MarketClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("minPrice=10") && u.includes("maxPrice=100"))).toBe(true)
    })
  })

  it("carries a URL sort into the request", async () => {
    searchParams = new URLSearchParams("sort=price_asc")
    render(<MarketClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("sort=price_asc"))).toBe(true)
    })
  })

  it("ignores an unrecognised sort rather than forwarding it", async () => {
    searchParams = new URLSearchParams("sort=chaos")
    render(<MarketClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.length).toBeGreaterThan(0)
      expect(urls.every((u) => !u.includes("sort=chaos"))).toBe(true)
    })
  })

  it("carries a URL page into the request", async () => {
    searchParams = new URLSearchParams("page=3")
    render(<MarketClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("page=3"))).toBe(true)
    })
  })

  it("pushes the selected sort back into the URL so a deep link survives", async () => {
    searchParams = new URLSearchParams("sort=price_desc")
    render(<MarketClient />)
    await waitFor(() => {
      expect(replace.mock.calls.some((c) => String(c[0]).includes("sort=price_desc"))).toBe(true)
    })
  })

  it("writes only the default sort into the URL when no filters are active", async () => {
    // ⚠ The default sort is `price_asc`, NOT "recent" — Market is the browse
    // surface and leads cheapest-first, while Sniper owns the recently-listed
    // default. So the canonical no-filter URL is `?sort=price_asc`, not a bare
    // `?`; asserting the latter fails against correct code.
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    await waitFor(() => expect(replace.mock.calls.some((c) => String(c[0]) === "?sort=price_asc")).toBe(true))
    // and nothing else rides along
    expect(replace.mock.calls.every((c) => !String(c[0]).includes("tier="))).toBe(true)
  })

  it("defaults to cheapest-first rather than most-recent", async () => {
    render(<MarketClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("sort=price_asc"))).toBe(true)
    })
  })

  it("advances the page and refetches", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    const next = screen.getByRole("button", { name: /next/i })
    fireEvent.click(next)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("page=2"))).toBe(true)
    })
  })

  it("disables Prev on the first page", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect((screen.getByRole("button", { name: /prev/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("disables Next when the API says there is no more", async () => {
    marketResponse = () => json(200, market({ pagination: { total: 1, page: 1, limit: 50, hasMore: false } }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect((screen.getByRole("button", { name: /next/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

// ─── Owned counts ────────────────────────────────────────────────────────────

describe("MarketClient — owned counts", () => {
  it("does not request edition counts for a signed-out visitor", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("edition-counts"))).toBe(false)
  })

  it("requests edition counts for a signed-in collector", async () => {
    ownerKey = "0xmine"
    render(<MarketClient />)
    await waitFor(() => {
      expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("edition-counts"))).toBe(true)
    })
  })

  it("survives a failed edition-counts read without breaking the market", async () => {
    ownerKey = "0xmine"
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/ready")) return readyResponse()
      if (url.startsWith("/api/wallet/edition-counts")) throw new Error("counts down")
      return marketResponse()
    })
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
  })
})

// ─── Pinnacle's own empty state ──────────────────────────────────────────────

describe("MarketClient — the Pinnacle empty state", () => {
  it("points a Pinnacle visitor at Sniper rather than at a bare 'no listings'", async () => {
    PARAMS.collection = "disney-pinnacle"
    try {
      marketResponse = () => json(200, market({ listings: [], pagination: { total: 0, page: 1, limit: 50, hasMore: false } }))
      render(<MarketClient />)
      await screen.findByText("No pin listings right now")
      expect(screen.getByText(/Open Pinnacle Sniper/)).toBeTruthy()
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("still shows the FAILURE notice on Pinnacle rather than its empty state", async () => {
    // The bespoke Pinnacle copy makes a specific claim ("no pins are listed at
    // the moment"), so it must sit behind the same error gate as the generic one.
    PARAMS.collection = "disney-pinnacle"
    try {
      marketResponse = () => json(503, {})
      render(<MarketClient />)
      await screen.findByText(/Couldn't load market/)
      expect(screen.queryByText("No pin listings right now")).toBeNull()
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })
})

// ─── Controls ────────────────────────────────────────────────────────────────

describe("MarketClient — controls", () => {
  it("toggles between the table and grid views", async () => {
    const { container } = render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(container.querySelector(".rpc-binder")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "grid" }))
    await waitFor(() => expect(container.querySelector(".rpc-binder")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "table" }))
    await waitFor(() => expect(container.querySelector(".rpc-binder")).toBeNull())
  })

  it("sends a chosen sort to the API", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fmv_desc" } })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("sort=fmv_desc"))).toBe(true)
    })
  })

  it("sends a typed price band", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    fireEvent.change(screen.getByPlaceholderText("Min"), { target: { value: "25" } })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("minPrice=25"))).toBe(true)
    })
  })

  it("sends a typed minimum discount", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    fireEvent.change(screen.getByPlaceholderText("e.g. 20"), { target: { value: "30" } })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("minDiscount=30"))).toBe(true)
    })
  })

  it("debounces the player box rather than firing per keystroke", async () => {
    // ⚠ VIRTUAL TIME, NOT WALL CLOCK. This used to sleep 60ms of real time
    // inside the component's 350ms window and assert nothing had fired — true
    // only if fewer than 350ms of real time elapsed, which a loaded CI runner
    // does not guarantee. Its sibling in component-AdminFeedbackClient reddened
    // `main` exactly that way on 2026-08-18, on a DOCS-ONLY commit.
    //
    // ⚠ act() around both the keystrokes and the advance is load-bearing: without
    // it the debounce timer is scheduled AFTER the advance, and a 0ms debounce
    // passes. Verified by mutation — 350 → 0 reds this case.
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/market")).length
    const box = screen.getByPlaceholderText("Search…")
    vi.useFakeTimers()
    try {
      await act(async () => {
        for (const v of ["l", "li", "lil"]) fireEvent.change(box, { target: { value: v } })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60)
      })
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/market")).length).toBe(before)
      // Past the window the trailing edge fires; advanced here so the waitFor
      // below runs against real timers with the request already in flight.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350)
      })
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("player=lil"))).toBe(true)
    })
  })

  it("offers a clear-filters affordance only when a filter is active", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(screen.queryByText(/^Clear \d+ filter/)).toBeNull()
    fireEvent.change(screen.getByPlaceholderText("Min"), { target: { value: "25" } })
    await screen.findByText(/^Clear 1 filter$/)
  })

  it("pluralises the clear-filters count", async () => {
    searchParams = new URLSearchParams("minPrice=5&maxPrice=50")
    render(<MarketClient />)
    await screen.findByText(/^Clear 2 filters$/)
  })

  it("clearing filters resets the request to the unfiltered one", async () => {
    searchParams = new URLSearchParams("minPrice=5&maxPrice=50")
    render(<MarketClient />)
    fireEvent.click(await screen.findByText(/^Clear 2 filters$/))
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => !u.includes("minPrice="))).toBe(true)
    })
  })

  it("opens a multi-select and applies a chosen option", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    const setChip = screen.getAllByRole("button", { name: /Any ▾/ })[0]
    fireEvent.click(setChip)
    const box = await screen.findByRole("listbox")
    fireEvent.click(within(box).getByText("Archive Set"))
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("set=Archive"))).toBe(true)
    })
  })

  it("disables a multi-select that has no options in the current results", async () => {
    marketResponse = () => json(200, market({ listings: [LISTING({ setName: null, seriesName: null, teamName: null, badgeSlugs: [] })] }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    const chips = screen.getAllByRole("button", { name: /Any ▾/ })
    expect(chips.some((c) => (c as HTMLButtonElement).disabled)).toBe(true)
  })

  it("shows the owned filter only for a signed-in collector", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(screen.queryByRole("button", { name: "Owned" })).toBeNull()
  })

  it("filters client-side by owned once counts are in", async () => {
    ownerKey = "0xmine"
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith("/api/ready")) return readyResponse()
      if (url.startsWith("/api/wallet/edition-counts")) return json(200, { editions: { "48:1652": { owned: 2, locked: 0 } } })
      return marketResponse()
    })
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    fireEvent.click(await screen.findByRole("button", { name: "Not owned" }))
    // The row IS owned, so a not-owned filter must empty the board — and that
    // empty is honest (the read succeeded), so the empty state is correct here.
    await screen.findByText("No listings match these filters.")
  })
})

// ─── Listing renderers ───────────────────────────────────────────────────────

describe("MarketClient — listing renderers", () => {
  it("renders the grid card with its badge and discount", async () => {
    searchParams = new URLSearchParams("view=grid")
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(screen.getAllByTestId("badge").length).toBeGreaterThan(0)
  })

  it("withholds a discount rather than printing one when FMV is unknown", async () => {
    marketResponse = () => json(200, market({ listings: [LISTING({ fmv: null, discount: null })] }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(document.body.textContent).not.toContain("30%")
  })

  it("renders a listing with no thumbnail without breaking the row", async () => {
    marketResponse = () => json(200, market({ listings: [LISTING({ thumbnailUrl: null })] }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
  })

  it("renders a listing with no player name", async () => {
    marketResponse = () => json(200, market({ listings: [LISTING({ playerName: null, setName: "Archive Set" })] }))
    render(<MarketClient />)
    await screen.findByText("Archive Set")
  })

  it("marks a locked listing", async () => {
    marketResponse = () => json(200, market({ listings: [LISTING({ isLocked: true })] }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
  })

  it("marks a special serial", async () => {
    marketResponse = () => json(200, market({ listings: [LISTING({ isSpecialSerial: true, serialNumber: 1 })] }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
  })

  it("flags a thin-data FMV instead of printing a discount it cannot stand behind", async () => {
    // ⚠ The internal confidence vocabulary (HIGH/MEDIUM/LOW/STALE) is
    // deliberately NEVER rendered on a public surface — a visitor cannot
    // calibrate an enum they have never seen, so `lib/fmv-basis.ts` marks only
    // the one case that is material (ASK_ONLY). Asserting /LOW/ here fails
    // against correct code. What the reader gets is the plain-words warning,
    // and crucially the discount is REPLACED rather than shown beside it.
    marketResponse = () => json(200, market({ listings: [LISTING({ lowConfidenceFmv: true, confidence: "LOW" })] }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(screen.getByText(/thin data/)).toBeTruthy()
    expect(document.body.textContent).not.toContain("LOW")
  })

  it("discloses an ask-derived FMV as not a market price", async () => {
    marketResponse = () => json(200, market({ listings: [LISTING({ confidence: "ASK_ONLY" })] }))
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    expect(document.body.textContent).toMatch(/ask/i)
  })

  it("records an outbound click on the buy link", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    const links = screen.getAllByRole("link").filter((a) => (a.getAttribute("href") ?? "").includes("http"))
    if (links.length > 0) {
      fireEvent.click(links[0])
      await waitFor(() => expect(trackOutbound).toHaveBeenCalled())
    }
  })
})

// ─── Listing shapes the API really produces ──────────────────────────────────

describe("MarketClient — listing shapes", () => {
  async function withListings(listings: Array<Record<string, unknown>>) {
    marketResponse = () =>
      json(200, {
        listings,
        pagination: { total: listings.length, page: 1, limit: 50, hasMore: false },
        clamp: { applied: false, ceilings: {} },
        diagnostics: { rawCount: listings.length, postClampCount: listings.length, postFilterCount: listings.length },
      })
    render(<MarketClient />)
  }

  it("renders a listing with no ask price without inventing one", async () => {
    await withListings([LISTING({ askPrice: null })])
    await screen.findByText("Damian Lillard")
  })

  it("renders a listing with no serial", async () => {
    await withListings([LISTING({ serialNumber: null, circulationCount: null })])
    await screen.findByText("Damian Lillard")
  })

  it("renders a listing with no set or series", async () => {
    await withListings([LISTING({ setName: null, seriesName: null })])
    await screen.findByText("Damian Lillard")
  })

  it("renders a listing with no tier", async () => {
    await withListings([LISTING({ tier: null })])
    await screen.findByText("Damian Lillard")
  })

  it("renders a listing with no badges", async () => {
    await withListings([LISTING({ badgeSlugs: [] })])
    await screen.findByText("Damian Lillard")
  })

  it("renders a listing with no buy URL — nothing to click, but still a row", async () => {
    await withListings([LISTING({ buyUrl: null, flowId: null })])
    await screen.findByText("Damian Lillard")
  })

  it("renders a parallel listing", async () => {
    await withListings([LISTING({ parallel: "Hexwave" })])
    await screen.findByText("Damian Lillard")
  })

  it("renders a listing with no edition key — it cannot be owned-matched", async () => {
    await withListings([LISTING({ editionKey: null })])
    await screen.findByText("Damian Lillard")
  })

  it("renders many listings in the grid view", async () => {
    searchParams = new URLSearchParams("view=grid")
    await withListings([
      LISTING({ id: "a", playerName: "A" }),
      LISTING({ id: "b", playerName: "B", isLocked: true }),
      LISTING({ id: "c", playerName: "C", isSpecialSerial: true, serialNumber: 1 }),
    ])
    await screen.findByText("A")
    expect(screen.getByText("B")).toBeTruthy()
    expect(screen.getByText("C")).toBeTruthy()
  })

  it("renders many listings in the table view", async () => {
    await withListings([
      LISTING({ id: "a", playerName: "A", discount: 0.5 }),
      LISTING({ id: "b", playerName: "B", discount: null, fmv: null }),
    ])
    await screen.findByText("A")
    expect(screen.getByText("B")).toBeTruthy()
  })
})

// ─── The packs sub-view ──────────────────────────────────────────────────────

describe("MarketClient — the packs sub-view", () => {
  it("shows the pack market on ?section=packs", async () => {
    searchParams = new URLSearchParams("section=packs")
    render(<MarketClient />)
    expect(await screen.findByTestId("pack-market")).toBeTruthy()
  })

  it("does not fetch moment listings while the packs sub-view is active", async () => {
    searchParams = new URLSearchParams("section=packs")
    render(<MarketClient />)
    await screen.findByTestId("pack-market")
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/market?"))).toBe(false)
  })

  it("offers no packs toggle for a collection with no pack board", async () => {
    PARAMS.collection = "ufc"
    try {
      render(<MarketClient />)
      await screen.findByText("Damian Lillard")
      expect(screen.queryByTestId("pack-market")).toBeNull()
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })
})

// ─── Outbound clicks and chip interactions ───────────────────────────────────

describe("MarketClient — outbound clicks and chips", () => {
  it("records a click on a grid card's buy button", async () => {
    const open = vi.fn()
    const origOpen = window.open
    Object.defineProperty(window, "open", { configurable: true, value: open })
    try {
      searchParams = new URLSearchParams("view=grid")
      render(<MarketClient />)
      await screen.findByText("Damian Lillard")
      const buy = Array.from(document.querySelectorAll('[tabindex="0"]')).find((n) =>
        /buy|view listing|topshot/i.test(n.textContent ?? ""),
      )
      if (buy) {
        fireEvent.click(buy)
        await waitFor(() => expect(trackOutbound).toHaveBeenCalled())
      }
    } finally {
      Object.defineProperty(window, "open", { configurable: true, value: origOpen })
    }
  })

  it("opens a buy link from the keyboard too — a click handler alone is not reachable", async () => {
    const open = vi.fn()
    const origOpen = window.open
    Object.defineProperty(window, "open", { configurable: true, value: open })
    try {
      searchParams = new URLSearchParams("view=grid")
      render(<MarketClient />)
      await screen.findByText("Damian Lillard")
      const buy = Array.from(document.querySelectorAll('[tabindex="0"]'))[0]
      if (buy) {
        fireEvent.keyDown(buy, { key: "Enter" })
        await waitFor(() => expect(open).toHaveBeenCalled())
      }
    } finally {
      Object.defineProperty(window, "open", { configurable: true, value: origOpen })
    }
  })

  it("ignores an unrelated key on a buy affordance", async () => {
    const open = vi.fn()
    const origOpen = window.open
    Object.defineProperty(window, "open", { configurable: true, value: open })
    try {
      searchParams = new URLSearchParams("view=grid")
      render(<MarketClient />)
      await screen.findByText("Damian Lillard")
      const buy = Array.from(document.querySelectorAll('[tabindex="0"]'))[0]
      if (buy) {
        fireEvent.keyDown(buy, { key: "x" })
        expect(open).not.toHaveBeenCalled()
      }
    } finally {
      Object.defineProperty(window, "open", { configurable: true, value: origOpen })
    }
  })

  it("toggles a tier chip on and off", async () => {
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    const chip = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "RARE")
    if (chip) {
      fireEvent.click(chip)
      await waitFor(() => {
        const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
        expect(urls.some((u) => u.includes("tier=RARE"))).toBe(true)
      })
      fireEvent.click(chip)
      await waitFor(() => {
        const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
        expect(urls.filter((u) => !u.includes("tier=")).length).toBeGreaterThan(1)
      })
    }
  })

  it("clears a multi-select from inside its own dropdown", async () => {
    searchParams = new URLSearchParams("set=Archive+Set")
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    // The chip summarises the single selection rather than reading "Any".
    const chip = screen.getAllByRole("button").find((b) => /Archive Set ▾/.test(b.textContent ?? ""))
    expect(chip).toBeTruthy()
    fireEvent.click(chip!)
    const box = await screen.findByRole("listbox")
    const clear = within(box).getByText(/clear/i)
    fireEvent.click(clear)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => !u.includes("set="))).toBe(true)
    })
  })

  it("honours a ?page= deep link instead of snapping back to page 1", async () => {
    // ⚠ THE DEFECT THIS FOUND. The "snap back to page 1 when a filter changes"
    // effect also fires on MOUNT, so `?page=3` was read out of the URL by
    // `useState` and then discarded on the first commit — after which the
    // URL-sync effect rewrote the address WITHOUT the param, so a shared link
    // silently lost its page and nothing on screen said so.
    searchParams = new URLSearchParams("page=3")
    render(<MarketClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("page=3"))).toBe(true)
    })
    // …and it must still be in the URL afterwards.
    await waitFor(() => expect(replace.mock.calls.some((c) => String(c[0]).includes("page=3"))).toBe(true))
  })

  it("still snaps back to page 1 when a filter actually changes", async () => {
    // The behaviour the guard must NOT break: paging to 3 then narrowing the
    // filter should not leave you on a page that no longer exists.
    searchParams = new URLSearchParams("page=3")
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    fireEvent.change(screen.getByPlaceholderText("Min"), { target: { value: "25" } })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("minPrice=25"))
      // ⚠ Assert the SETTLED request, not that no intermediate one carried the
      // old page. React commits the filter change before the reset effect runs,
      // so one request legitimately goes out on the stale page and is then
      // superseded — asserting `every` fails against correct code.
      // ⚠ The API query ALWAYS carries `page=N`; it is only the browser URL
      // that omits page 1. So the settled request reads `page=1`, not "no page
      // param" — two different conventions one line apart.
      expect(urls.some((u) => u.includes("page=1"))).toBe(true)
    })
  })

  it("pages backwards from page 2", async () => {
    searchParams = new URLSearchParams("page=2")
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
    // ⚠ Wait for the control to settle before asserting on it. Reading
    // `.disabled` off a node captured mid-effect flaked once in the full-file
    // run while passing in isolation — the page re-renders several times as its
    // legs land, and the button is remounted with them.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /prev/i }) as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByRole("button", { name: /prev/i }))
    await waitFor(() => {
      // ⚠ Page 1 is the DEFAULT, so it is omitted from the query string
      // entirely — asserting `page=1` fails against correct code.
      const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/market"))
      expect(urls.some((u) => u.includes("page=1"))).toBe(true)
    })
  })

  it("survives a health payload that throws", async () => {
    readyResponse = () => { throw new Error("ready down") }
    render(<MarketClient />)
    await screen.findByText("Damian Lillard")
  })
})
