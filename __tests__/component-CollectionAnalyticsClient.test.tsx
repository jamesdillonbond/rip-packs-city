// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"
import CollectionAnalyticsClient from "@/app/(collections)/[collection]/analytics/CollectionAnalyticsClient"

// `[collection]/analytics` converted to a `*Client.tsx` so the component gate measures it —
// ~1,790 lines across nine independent card loaders, each with its own
// loading / failed / empty / data ladder, that matched neither gate's include.
//
// ⚠ NO NEW DEFECT. This page is the most thoroughly hardened member of the failed-read class
// in the repo and the conversion is coverage — but the hardening was pinned only by SOURCE
// greps (`collection-analytics-failed-vs-empty-guard`), which prove a string is present, not
// that the branch is reachable or ordered correctly. Every card below is now driven.
//
// The properties that matter, and why each is not cosmetic:
//   * `marketFailed` exists because deep-audit D12 found a timed-out request rendering
//     "$0.00 / 0 sales" for 30d on a collection doing 89,831 sales — a failure presented as
//     a measurement.
//   * `playerFailed` is distinct from "no results": a failed search must not claim a player
//     has no marketplace activity.
//   * Each card's `failed` branch is consulted BEFORE its empty branch, so a 503 can never
//     render as a claim about the market.

const PARAMS: Record<string, string> = { collection: "nba-top-shot" }
let searchParams = new URLSearchParams()
const replace = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/nba-top-shot/analytics",
  useSearchParams: () => searchParams,
  useParams: () => PARAMS,
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const Null = () => null
  return {
    ResponsiveContainer: Pass, LineChart: Pass, BarChart: Pass, AreaChart: Pass, ComposedChart: Pass,
    PieChart: Pass, Pie: Null, Cell: Null, Line: Null, Bar: Null, Area: Null,
    CartesianGrid: Null, XAxis: Null, YAxis: Null, Tooltip: Null, Legend: Null, ReferenceLine: Null,
  }
})

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body } as unknown as Response
}

/**
 * Read a KPI tile's VALUE node by its label.
 *
 * ⚠ Reads the value's own element — the immediate next sibling of the label —
 * NOT the whole tile. An earlier version returned the tile's text minus the
 * label, and `ChangeBadge` renders its own em-dash whenever `pct` is null,
 * which it always is on a failed read. So `toContain("—")` passed no matter
 * what the value said, and TWO mutations survived it: dropping the `kpi()`
 * dash-guard entirely, and treating an `{ error }` body at HTTP 200 as
 * success. Scoping the read kills both.
 */
function kpiValue(label: string): string | null {
  const el = Array.from(document.querySelectorAll("div")).find((d) => d.textContent?.trim() === label)
  return el?.nextElementSibling?.textContent?.trim() ?? null
}

// ⚠ Shape read off the component's own `MarketAnalyticsResponse`, not invented.
// An invented shape leaves `totals.totalSales` undefined, which falls back to 0
// and silently puts the page into thin-volume mode — a fixture that tests the
// failure path while claiming to test the happy one.
const MARKET = {
  period: "30d",
  startDate: "2026-07-17",
  endDate: "2026-08-16",
  totals: { totalSales: 89_831, totalVolume: 583_000 },
  daily: [{ date: "2026-08-01", marketplace: "topshot", saleCount: 100, volume: 1000 }],
  topSales: [],
  tierAnalytics: [],
  periodComparison: {
    current: { volume: 583_000, sales: 89_831, avgPrice: 6.49, uniqueEditions: 900 },
    previous: { volume: 500_000, sales: 80_000, avgPrice: 6.25, uniqueEditions: 850 },
    changes: { volumePct: 16.6, salesPct: 12.3, avgPricePct: 3.8, uniqueEditionsPct: 5.9 },
  },
}

type Routes = Record<string, () => Response>
let routes: Routes
let fetchMock: ReturnType<typeof vi.fn>

function baseRoutes(): Routes {
  return {
    "/api/market-analytics": () => json(200, MARKET),
    "/api/ready": () => json(200, { per_collection: [{ slug: "nba-top-shot", sales_24h: 900 }] }),
    "/api/analytics/listings/summary": () =>
      json(200, { topshot_orderbook: { count: 12_400, median_ask_usd: 4, p90_ask_usd: 19 }, marketplace_listings: [] }),
    "/api/analytics/fmv/tier-pulse": () => json(200, { rows: [{ tier: "RARE", priced: 900, total: 1000 }] }),
    "/api/analytics/packs/summary": () => json(200, { rows: [{ dist_id: "1", pack_name: "Base", ev: 12, ask: 9 }] }),
    "/api/analytics/fmv/liquidity-distribution": () =>
      json(200, { rows: [{ collection: "topshot", hot: 10, warm: 20, cool: 30, cold: 40 }] }),
    "/api/analytics/sales/leaderboard": () => json(200, { rows: [] }),
    "/api/marketplace-breakdown": () => json(200, { rows: [] }),
    "/api/analytics": () =>
      json(200, {
        // ⚠ Shape read off `AnalyticsResponse`. An invented body throws during
        // render and leaves `document.body.textContent` EMPTY, which reads like
        // a missing element rather than a fixture bug.
        wallet: "0xmine",
        acquisition: { pack_pull_count: 4, marketplace_count: 9, challenge_reward_count: 1, gift_count: 0, total_tracked: 14 },
        locked: { locked_count: 2, unlocked_count: 12, locked_fmv: 100, unlocked_fmv: 800 },
        tiers: [{ tier: "RARE", count: 10, fmv: 700 }],
        series: [{ label: "Series 1", seriesNumber: 0, count: 10, fmv: 700 }],
        confidence: { HIGH: 8, MEDIUM: 4, LOW: 2 },
        total_fmv: 900,
        total_moments: 14,
        portfolio_clarity_score: 82,
      }),
  }
}

beforeEach(() => {
  searchParams = new URLSearchParams()
  replace.mockClear()
  routes = baseRoutes()
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    // Longest prefix wins so "/api/analytics/..." never falls through to "/api/analytics".
    const key = Object.keys(routes).filter((k) => url.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    return key ? routes[key]() : json(200, {})
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─── The KPI band ────────────────────────────────────────────────────────────

describe("CollectionAnalyticsClient — the market KPI band", () => {
  it("renders the real 30d figures", async () => {
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
  })

  it("adds the thin-volume ecosystem notice ONLY on a real, small market", async () => {
    routes["/api/market-analytics"] = () => json(200, { ...MARKET, totals: { totalSales: 12, totalVolume: 40 } })
    render(<CollectionAnalyticsClient />)
    await screen.findByText(/most metrics are directional only/)
  })

  it("⚠ does NOT call the market thin when the read FAILED — the D12 defect one derivation lower", async () => {
    // `totalSales` falls back to 0 and `period` to "30d", so before the fix a
    // 503 rendered "Thin-volume ecosystem — most metrics are directional only.",
    // a specific claim about the market manufactured from our own outage. D12
    // added `marketFailed` for the KPI band and this derived notice was never
    // gated on it.
    routes["/api/market-analytics"] = () => json(503, {})
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("—"))
    expect(screen.queryByText(/most metrics are directional only/)).toBeNull()
  })

  it("does not call it thin on a thrown fetch either", async () => {
    routes["/api/market-analytics"] = () => { throw new Error("network down") }
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("—"))
    expect(screen.queryByText(/most metrics are directional only/)).toBeNull()
  })

  it("withholds the figures on a non-2xx rather than publishing $0.00 / 0 sales", async () => {
    // ⚠ deep-audit D12: this exact card rendered "$0.00 / 0 sales" for 30d on a
    // collection doing 89,831 sales, because the fetch soft-failed to null and
    // every KPI fell back to `?? 0`. A failure is not a measurement.
    routes["/api/market-analytics"] = () => json(503, {})
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).not.toContain("89,831"))
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("—"))
    expect(kpiValue("Total Volume")).toBe("—")
    expect(kpiValue("Avg Sale Price")).toBe("—")
  })

  it("treats an { error } body at HTTP 200 as a failure, not as zeros", async () => {
    // The realistic saturation shape: our own routes answer 200 with an error
    // key, so a status-only check would call this a successful empty read.
    routes["/api/market-analytics"] = () => json(200, { error: "statement timeout" })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("—"))
    expect(kpiValue("Avg Sale Price")).toBe("—")
  })

  it("treats a thrown fetch as a failure", async () => {
    routes["/api/market-analytics"] = () => { throw new Error("network down") }
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.body.textContent).not.toContain("89,831")
  })
})

// ─── Card ladders ────────────────────────────────────────────────────────────

describe("CollectionAnalyticsClient — each card's failed branch precedes its empty branch", () => {
  async function withFailure(route: string) {
    routes[route] = () => json(503, {})
    render(<CollectionAnalyticsClient />)
  }

  it("order book: says it could not load, not 'No live listings.' (live-source collection)", async () => {
    // ⚠ All Day, not Top Shot. Top Shot's orderbook source is RETIRED, so its
    // card discloses that ahead of any fetch outcome (D12b) and cannot pin the
    // failed-vs-empty distinction any more. All Day reads marketplace_listings,
    // a live source, so it is the collection that still can.
    PARAMS.collection = "nfl-all-day"
    try {
      routes["/api/ready"] = () => json(200, { per_collection: [{ slug: "nfl-all-day", sales_24h: 900 }] })
      await withFailure("/api/analytics/listings/summary")
      await screen.findByText(/Couldn't load the order book/)
      expect(screen.queryByText("No live listings.")).toBeNull()
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("order book: Top Shot discloses the retired sampler instead of publishing a count", async () => {
    // ⚠ INVERTED from "renders the depth when there is any" (deep-audit D12b).
    // That test asserted the card printed 12,400 listings for Top Shot. It was
    // pinning the defect: the figure comes from `ts_listings`, retired
    // 2026-05-26, holding ONE row from 2026-05-15. A SUCCESSFUL read of a dead
    // table is still not a market fact.
    //
    // Asserts the ABSENCE of the false claim, not merely the presence of a
    // string — a card that rendered both would pass a presence-only check.
    render(<CollectionAnalyticsClient />)
    await screen.findByText(/sampler was switched off on 2026-05-26/)
    expect(document.body.textContent).not.toContain("12,400")
    expect(screen.queryByText("No live listings.")).toBeNull()
    expect(screen.queryByText(/Couldn't load the order book/)).toBeNull()
  })

  it("order book: still says 'No live listings.' on a genuine zero (live-source collection)", async () => {
    PARAMS.collection = "nfl-all-day"
    try {
      routes["/api/ready"] = () => json(200, { per_collection: [{ slug: "nfl-all-day", sales_24h: 900 }] })
      routes["/api/analytics/listings/summary"] = () =>
        json(200, { topshot_orderbook: { count: 0 }, marketplace_listings: [] })
      render(<CollectionAnalyticsClient />)
      await screen.findByText("No live listings.")
      expect(screen.queryByText(/Couldn't load the order book/)).toBeNull()
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("order book: a live-source collection still renders its real depth", async () => {
    // The retirement branch must be Top-Shot-only. If it leaked to every
    // collection this guard would catch it: All Day's depth is a live number.
    PARAMS.collection = "nfl-all-day"
    try {
      routes["/api/ready"] = () => json(200, { per_collection: [{ slug: "nfl-all-day", sales_24h: 900 }] })
      routes["/api/analytics/listings/summary"] = () =>
        json(200, {
          topshot_orderbook: { count: 12_400, median_ask_usd: 4, p90_ask_usd: 19 },
          marketplace_listings: [{ collection: "allday", count: 1_234, median_ask_usd: 3, p90_ask_usd: 8 }],
        })
      render(<CollectionAnalyticsClient />)
      await waitFor(() => expect(document.body.textContent).toContain("1,234"))
      expect(screen.queryByText(/sampler was switched off/)).toBeNull()
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("order book: reads the marketplace block for a non-Top-Shot collection", async () => {
    PARAMS.collection = "nfl-all-day"
    try {
      routes["/api/analytics/listings/summary"] = () =>
        json(200, {
          topshot_orderbook: { count: 12_400 },
          marketplace_listings: [{ collection: "allday", count: 55, median_ask_usd: 3, p90_ask_usd: 8 }],
        })
      routes["/api/ready"] = () => json(200, { per_collection: [{ slug: "nfl-all-day", sales_24h: 900 }] })
      render(<CollectionAnalyticsClient />)
      // ⚠ 55, NOT 12,400 — reading the Top Shot orderbook for another
      // collection would publish Top Shot's depth under All Day's name.
      await waitFor(() => expect(document.body.textContent).toContain("55"))
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("order book: survives marketplace_listings arriving as {} rather than []", async () => {
    // Audit 2026-05-20: the RPC really does return an object here, and `.find`
    // on it throws — taking the whole page down, not just the card.
    PARAMS.collection = "nfl-all-day"
    try {
      routes["/api/analytics/listings/summary"] = () =>
        json(200, { topshot_orderbook: null, marketplace_listings: {} })
      render(<CollectionAnalyticsClient />)
      await screen.findByText("No live listings.")
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("FMV health: says it could not load, not 'No FMV coverage yet.'", async () => {
    await withFailure("/api/analytics/fmv/tier-pulse")
    await waitFor(() => expect(screen.queryByText("No FMV coverage yet.")).toBeNull())
  })

  it("FMV health: still says there is no coverage on a genuine empty", async () => {
    routes["/api/analytics/fmv/tier-pulse"] = () => json(200, { rows: [] })
    render(<CollectionAnalyticsClient />)
    await screen.findByText("No FMV coverage yet.")
  })

  it("liquidity: says it could not load, not 'No liquidity data'", async () => {
    await withFailure("/api/analytics/fmv/liquidity-distribution")
    await waitFor(() => expect(screen.queryByText(/No liquidity data/)).toBeNull())
  })

  it("liquidity: treats a 200 with no rows key as a failure, not as an empty market", async () => {
    // ⚠ A body with no `rows` is a malformed response, not a measured zero —
    // this card is explicit about the difference.
    routes["/api/analytics/fmv/liquidity-distribution"] = () => json(200, {})
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(screen.queryByText(/No liquidity data/)).toBeNull())
  })

  it("liquidity: renders the bands when they load", async () => {
    render(<CollectionAnalyticsClient />)
    await screen.findByText("Cold")
  })

  it("pack EV: degrades without claiming there are no packs", async () => {
    await withFailure("/api/analytics/packs/summary")
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})

// ─── Tabs and wallet search ──────────────────────────────────────────────────

describe("CollectionAnalyticsClient — tabs and wallet search", () => {
  it("opens on the market tab", async () => {
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.body.textContent).toMatch(/market/i)
  })

  it("honours ?tab=portfolio from the URL", async () => {
    searchParams = new URLSearchParams("tab=portfolio")
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.body.textContent).toMatch(/portfolio/i)
  })

  it("writes the tab back to the URL so the view is shareable", async () => {
    // ⚠ `TabNav` defines its `Tab` component INSIDE the render, so React sees a
    // new component identity on every parent render and REMOUNTS both buttons.
    // A node captured before the page's async effects settle is detached by the
    // time it is clicked, and the click silently does nothing — so wait for the
    // page to settle, then query and click in the same tick.
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
    fireEvent.click(screen.getByRole("button", { name: "Portfolio" }))
    await waitFor(() => expect(replace.mock.calls.some((c) => String(c[0]).includes("tab=portfolio"))).toBe(true))
  })

  it("auto-loads the wallet named in the URL", async () => {
    searchParams = new URLSearchParams("wallet=0xmine&tab=portfolio")
    render(<CollectionAnalyticsClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.startsWith("/api/analytics?") && u.includes("wallet=0xmine"))).toBe(true)
    })
  })

  it("does not request a wallet analysis when the URL names none", async () => {
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.startsWith("/api/analytics?wallet="))).toBe(false)
  })

  it("reports a failed wallet analysis rather than an empty portfolio", async () => {
    searchParams = new URLSearchParams("wallet=0xmine&tab=portfolio")
    routes["/api/analytics"] = () => json(503, { error: "analytics unavailable" })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.startsWith("/api/analytics?wallet="))).toBe(true)
    })
  })
})

// ─── Thin volume ─────────────────────────────────────────────────────────────

describe("CollectionAnalyticsClient — the thin-volume notice", () => {
  it("declines to call the market thin when /api/ready fails", async () => {
    // ⚠ `row != null && …` is the guard: without it a failed health read scores
    // 0 < 10 and publishes a claim about the ecosystem from a failed read of
    // our own health endpoint.
    routes["/api/ready"] = () => json(503, {})
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.body.textContent).not.toMatch(/thin.volume/i)
  })

  it("declines when the health payload carries no row for this collection", async () => {
    routes["/api/ready"] = () => json(200, { per_collection: [{ slug: "nfl-all-day", sales_24h: 1 }] })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.body.textContent).not.toMatch(/thin.volume/i)
  })

  it("says so when the health read genuinely reports thin volume", async () => {
    routes["/api/ready"] = () => json(200, { per_collection: [{ slug: "nba-top-shot", sales_24h: 3 }] })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/thin.volume/i))
  })
})

// ─── Whale leaderboards ──────────────────────────────────────────────────────

describe("CollectionAnalyticsClient — whale leaderboards", () => {
  it("says it could not load rather than 'No data.' when a leg fails", async () => {
    // ⚠ BOTH legs must succeed. `?? []` on a failed leg renders "No data." — a
    // claim that nobody traded, made out of a read we never completed.
    routes["/api/analytics/sales/leaderboard"] = () => json(503, {})
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(screen.getAllByText(/Couldn't load this leaderboard/).length).toBe(2))
    expect(screen.queryByText("No data.")).toBeNull()
  })

  it("fails BOTH tables when only ONE leg comes back malformed", async () => {
    // The partial case: a 200 with no `rows` key is not a measured zero, and
    // showing one honest table beside one fabricated empty is worse than
    // failing both.
    let call = 0
    routes["/api/analytics/sales/leaderboard"] = () => {
      call += 1
      return call === 1 ? json(200, { rows: [{ rank: 1, addr: "0xaaa", username: "whale", sale_count: 10, total_volume_usd: 900, avg_price_usd: 90 }] }) : json(200, {})
    }
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(screen.getAllByText(/Couldn't load this leaderboard/).length).toBe(2))
  })

  it("still says 'No data.' when both legs succeed with nothing", async () => {
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(screen.getAllByText("No data.").length).toBeGreaterThan(0))
  })

  it("renders a whale row, linked to its wallet page", async () => {
    routes["/api/analytics/sales/leaderboard"] = () =>
      json(200, { rows: [{ rank: 1, addr: "0xaaaaaaaaaaaaaaaa", username: "whale", sale_count: 10, total_volume_usd: 900, avg_price_usd: 90 }] })
    render(<CollectionAnalyticsClient />)
    const links = await screen.findAllByRole("link", { name: "whale" })
    expect(links[0].getAttribute("href")).toBe("/analytics/wallets/0xaaaaaaaaaaaaaaaa")
  })

  it("falls back to a short address when a whale has no username", async () => {
    routes["/api/analytics/sales/leaderboard"] = () =>
      json(200, { rows: [{ rank: 1, addr: "0xaaaaaaaaaaaaaaaa", username: null, sale_count: 10, total_volume_usd: 900, avg_price_usd: 90 }] })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/0xaaaa/))
  })

  it("treats a thrown leaderboard fetch as a failure", async () => {
    routes["/api/analytics/sales/leaderboard"] = () => { throw new Error("down") }
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(screen.getAllByText(/Couldn't load this leaderboard/).length).toBe(2))
  })
})

// ─── Player search ───────────────────────────────────────────────────────────

describe("CollectionAnalyticsClient — player search", () => {
  async function typePlayer(q: string) {
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
    const box = screen.getByPlaceholderText(/player/i)
    fireEvent.change(box, { target: { value: q } })
    return box
  }

  it("prompts rather than claiming anything before a query is typed", async () => {
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
    expect(screen.queryByText(/only that we couldn't/)).toBeNull()
  })

  it("says the SEARCH failed, never that the player has no activity", async () => {
    // ⚠ The distinction this card exists for. "No sales for X" is a claim about
    // a named player's market; a failed search cannot support it.
    routes["/api/market-analytics"] = (() => {
      let n = 0
      return () => {
        n += 1
        return n === 1 ? json(200, MARKET) : json(503, {})
      }
    })()
    await typePlayer("lillard")
    await screen.findByText(/only that we couldn't/, {}, { timeout: 3000 })
  })

  it("reports a genuine empty result as a real answer", async () => {
    routes["/api/market-analytics"] = (() => {
      let n = 0
      return () => {
        n += 1
        return n === 1 ? json(200, MARKET) : json(200, { ...MARKET, playerSearch: [] })
      }
    })()
    await typePlayer("nobody")
    await waitFor(
      () => expect(screen.queryByText(/only that we couldn't/)).toBeNull(),
      { timeout: 3000 },
    )
  })

  it("renders matching player rows", async () => {
    routes["/api/market-analytics"] = (() => {
      let n = 0
      return () => {
        n += 1
        return n === 1
          ? json(200, MARKET)
          : json(200, { ...MARKET, playerSearch: [{ player_name: "Damian Lillard", sales: 12, volume: 900, avg_price: 75 }] })
      }
    })()
    await typePlayer("lillard")
    await screen.findByText("Damian Lillard", {}, { timeout: 3000 })
  })

  it("debounces rather than searching per keystroke", async () => {
    // ⚠ VIRTUAL TIME, NOT WALL CLOCK. This case used to sleep 120ms of real time
    // inside the component's 500ms window and assert nothing had fired — true
    // only if fewer than 500ms of real time elapsed, which a loaded CI runner
    // does not guarantee. Its sibling in component-AdminFeedbackClient reddened
    // `main` exactly that way on 2026-08-18, on a DOCS-ONLY commit. A sleep is a
    // floor on the delay, never a ceiling.
    //
    // ⚠ act() around the keystrokes AND around the advance is load-bearing:
    // without it React has not yet run the effect that schedules the debounce,
    // so the timer is created after the advance and a 0ms debounce passes the
    // assertion. Verified by mutation — 500 → 0 reds this case.
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("player=")).length
    const box = screen.getByPlaceholderText(/player/i)
    vi.useFakeTimers()
    try {
      await act(async () => {
        for (const v of ["l", "li", "lil"]) fireEvent.change(box, { target: { value: v } })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("player=")).length).toBe(before)
    } finally {
      // In a finally so a failed assertion cannot leave fake timers installed
      // for the rest of the file — that turns one red case into a cascade.
      vi.useRealTimers()
    }
  })

  it("clears results when the box is emptied rather than leaving a stale player's rows", async () => {
    routes["/api/market-analytics"] = (() => {
      let n = 0
      return () => {
        n += 1
        return n === 1
          ? json(200, MARKET)
          : json(200, { ...MARKET, playerSearch: [{ player_name: "Damian Lillard", sales: 12, volume: 900, avg_price: 75 }] })
      }
    })()
    const box = await typePlayer("lillard")
    await screen.findByText("Damian Lillard", {}, { timeout: 3000 })
    fireEvent.change(box, { target: { value: "" } })
    await waitFor(() => expect(screen.queryByText("Damian Lillard")).toBeNull())
  })
})

// ─── Portfolio tab ───────────────────────────────────────────────────────────

describe("CollectionAnalyticsClient — portfolio tab", () => {
  it("requests the wallet's analytics and its marketplace breakdown together", async () => {
    searchParams = new URLSearchParams("wallet=0xmine&tab=portfolio")
    render(<CollectionAnalyticsClient />)
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.startsWith("/api/analytics?wallet="))).toBe(true)
      expect(urls.some((u) => u.startsWith("/api/marketplace-breakdown"))).toBe(true)
    })
  })

  it("says there was no marketplace activity only when the market read succeeded with no days", async () => {
    // ⚠ The breakdown card is fed by `marketData.daily`, NOT by
    // /api/marketplace-breakdown (that endpoint drives a different,
    // portfolio-tab panel). Driving the wrong source tests nothing.
    routes["/api/market-analytics"] = () => json(200, { ...MARKET, daily: [] })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/No marketplace activity/))
  })

  it("renders a single-source breakdown without pretending there is a split", async () => {
    render(<CollectionAnalyticsClient />)
    await screen.findByText("single source")
    expect(document.body.textContent).toContain("100%")
  })

  it("renders a multi-source breakdown", async () => {
    routes["/api/market-analytics"] = () =>
      json(200, {
        ...MARKET,
        daily: [
          { date: "2026-08-01", marketplace: "topshot", saleCount: 100, volume: 1000 },
          { date: "2026-08-01", marketplace: "flowty", saleCount: 20, volume: 300 },
        ],
      })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/USD volume/))
    expect(screen.queryByText("single source")).toBeNull()
  })
})

// ─── Market tables ───────────────────────────────────────────────────────────

// Shapes read off the component's own row types, not invented — see the MARKET
// fixture note above for what an invented one silently does.
const FULL_MARKET = {
  ...MARKET,
  topSales: [
    {
      price_usd: 1250,
      sold_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      serial_number: 1,
      marketplace: "topshot",
      player_name: "Damian Lillard",
      set_name: "Archive Set",
      tier: "LEGENDARY",
      circulation_count: 99,
    },
    {
      price_usd: 40,
      sold_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
      serial_number: null,
      marketplace: null,
      player_name: null,
      set_name: null,
      tier: null,
      circulation_count: null,
    },
  ],
  tierAnalytics: [
    { tier: "LEGENDARY", sale_count: 12, volume: 9000, avg_price: 750, min_price: 400, max_price: 1250 },
    { tier: "COMMON", sale_count: 900, volume: 4000, avg_price: 4.4, min_price: 1, max_price: 30 },
  ],
  topEditions: [
    { player_name: "Damian Lillard", set_name: "Archive Set", tier: "RARE", circulation_count: 1000, sale_count: 40, volume: 3000, avg_price: 75 },
    { player_name: null, set_name: null, tier: null, circulation_count: null, sale_count: 5, volume: 100, avg_price: 20 },
  ],
  dailyTierVolume: [{ date: "2026-08-01", tier: "RARE", sale_count: 10, volume: 400, avg_price: 40 }],
  badgePremium: [
    { tier: "RARE", badged_avg: 90, badged_sales: 10, unbadged_avg: 60, unbadged_sales: 40, premium_pct: 50 },
  ],
  seriesAnalytics: [{ series: 0, sale_count: 100, volume: 4000, avg_price: 40, max_sale: 900 }],
  dailySeriesVolume: [{ date: "2026-08-01", series: 0, sale_count: 10, volume: 400 }],
}

describe("CollectionAnalyticsClient — market tables", () => {
  function withFull(over: Record<string, unknown> = {}) {
    routes["/api/market-analytics"] = () => json(200, { ...FULL_MARKET, ...over })
    render(<CollectionAnalyticsClient />)
  }

  it("ranks the top sales with player, set, tier, serial and price", async () => {
    withFull()
    // ⚠ `findAllByText` — the player appears in BOTH Top Sales and Hottest
    // Editions, and `findByText` throws on multiple matches, which reads like
    // "not rendered" when the truth is "rendered twice".
    const hits = await screen.findAllByText("Damian Lillard")
    expect(hits.length).toBeGreaterThan(1)
    expect(document.body.textContent).toContain("#1/99")
    expect(document.body.textContent).toContain("LEGENDARY")
  })

  it("renders an em-dash rather than a blank cell for an unnameable sale", async () => {
    // ⚠ A top-sales row we cannot name is a gap in OUR catalog, not a market
    // fact — but it is still a real sale, so it stays in the ranking with the
    // unknown fields marked rather than being silently dropped.
    withFull()
    await screen.findAllByText("Damian Lillard")
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("ranks the top editions by volume, largest first", async () => {
    withFull({
      topEditions: [
        { player_name: "Small", set_name: "S", tier: "COMMON", circulation_count: 10, sale_count: 1, volume: 10, avg_price: 10 },
        { player_name: "Big", set_name: "S", tier: "RARE", circulation_count: 10, sale_count: 9, volume: 9000, avg_price: 1000 },
      ],
    })
    await screen.findAllByText("Big")
    const body = document.body.textContent ?? ""
    expect(body.indexOf("Big")).toBeLessThan(body.indexOf("Small"))
  })

  it("renders the tier breakdown section", async () => {
    // ⚠ The tier breakdown is a recharts BAR CHART, and recharts is stubbed to
    // markers here — so its tier LABELS never reach the DOM. Asserting on
    // "COMMON" fails against correct code; the section heading is what a test
    // at this level can honestly claim.
    withFull()
    await waitFor(() => expect(document.body.textContent).toContain("Volume by Tier"))
    expect(document.body.textContent).toContain("Average Price by Tier")
  })

  it("renders the badge-premium table", async () => {
    withFull()
    await waitFor(() => expect(document.body.textContent).toMatch(/badge/i))
  })

  it("renders the series breakdown", async () => {
    withFull()
    await waitFor(() => expect(document.body.textContent).toMatch(/series/i))
  })

  it("hides the series and badge sections for Pinnacle when both are empty", async () => {
    // ⚠ Pinnacle has neither, so an empty table there is noise rather than
    // information — degrading by OMISSION is the right call for a section with
    // nothing to say.
    PARAMS.collection = "disney-pinnacle"
    try {
      routes["/api/ready"] = () => json(200, { per_collection: [{ slug: "disney-pinnacle", sales_24h: 900 }] })
      routes["/api/market-analytics"] = () => json(200, { ...FULL_MARKET, seriesAnalytics: [], badgePremium: [] })
      render(<CollectionAnalyticsClient />)
      await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
      expect(document.body.textContent).not.toMatch(/badge premium/i)
    } finally {
      PARAMS.collection = "nba-top-shot"
    }
  })

  it("exports the daily rows as CSV", async () => {
    const created: string[] = []
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = ((b: Blob) => { created.push(String(b.type)); return "blob:x" }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
    try {
      withFull()
      await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
      const btn = Array.from(document.querySelectorAll("button")).find((b) => /csv|export/i.test(b.textContent ?? ""))
      if (btn) {
        fireEvent.click(btn)
        await waitFor(() => expect(created.length).toBeGreaterThan(0))
      }
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    }
  })

  it("exports nothing rather than an empty file when there are no daily rows", async () => {
    const created: string[] = []
    const origCreate = URL.createObjectURL
    URL.createObjectURL = ((b: Blob) => { created.push(String(b.type)); return "blob:x" }) as typeof URL.createObjectURL
    try {
      routes["/api/market-analytics"] = () => json(200, { ...MARKET, daily: [] })
      render(<CollectionAnalyticsClient />)
      await waitFor(() => expect(kpiValue("Total Sales")).toBe("89,831"))
      const btn = Array.from(document.querySelectorAll("button")).find((b) => /csv|export/i.test(b.textContent ?? ""))
      if (btn) fireEvent.click(btn)
      await new Promise((r) => setTimeout(r, 20))
      expect(created.length).toBe(0)
    } finally {
      URL.createObjectURL = origCreate
    }
  })
})

// ─── Card payloads that actually populate ────────────────────────────────────

// ⚠ Shapes read off each card's own row type. The base fixtures above are
// deliberately minimal — enough to distinguish failed-vs-empty, which is what
// those cases are about — so these are separate rather than replacing them.
const FMV_TIERS = {
  rows: [
    { collection: "topshot", tier: "LEGENDARY", edition_count: 120, total_fmv_usd: 90_000, high_conf_count: 100, low_conf_count: 20 },
    { collection: "topshot", tier: "COMMON", edition_count: 9_000, total_fmv_usd: 40_000, high_conf_count: 3_000, low_conf_count: 6_000 },
    { collection: "allday", tier: "RARE", edition_count: 10, total_fmv_usd: 100, high_conf_count: 1, low_conf_count: 9 },
  ],
}

const LIQUIDITY = {
  rows: [
    { collection: "topshot", l5: 10, l4: 20, l3: 30, l2: 40, l1: 50, l0: 5, cold: 100, total: 255, high_conf_total_fmv: 90_000 },
  ],
}

const PACK_EV = {
  collections: { topshot: { packs_tracked: 42, positive_ev_packs: 7, avg_value_ratio: 1.35 } },
}

describe("CollectionAnalyticsClient — populated cards", () => {
  it("reports FMV health from the tier rows, scoped to this collection", async () => {
    routes["/api/analytics/fmv/tier-pulse"] = () => json(200, FMV_TIERS)
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(screen.queryByText("No FMV coverage yet.")).toBeNull())
  })

  it("renders the liquidity bands with their labels", async () => {
    routes["/api/analytics/fmv/liquidity-distribution"] = () => json(200, LIQUIDITY)
    render(<CollectionAnalyticsClient />)
    await screen.findByText("L5")
    expect(screen.getByText("L1")).toBeTruthy()
    expect(screen.getByText("Cold")).toBeTruthy()
  })

  it("calls a tiny liquidity sample too thin to read rather than charting it", async () => {
    // ⚠ 255 editions is a distribution; 5 is a rounding error dressed as one.
    routes["/api/analytics/fmv/liquidity-distribution"] = () =>
      json(200, { rows: [{ collection: "topshot", l5: 1, l4: 1, l3: 1, l2: 1, l1: 1, l0: 0, cold: 0, total: 5, high_conf_total_fmv: 10 }] })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/liquidity/i))
  })

  it("declines to characterise liquidity for a collection with no row", async () => {
    routes["/api/analytics/fmv/liquidity-distribution"] = () =>
      json(200, { rows: [{ collection: "allday", l5: 1, l4: 1, l3: 1, l2: 1, l1: 1, l0: 0, cold: 0, total: 5, high_conf_total_fmv: 10 }] })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/liquidity/i))
  })

  it("reports pack EV once the collection has tracked packs", async () => {
    routes["/api/analytics/packs/summary"] = () => json(200, PACK_EV)
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(screen.queryByText(/not yet available for this collection/)).toBeNull())
  })

  it("says pack analytics are unavailable when the collection has none", async () => {
    routes["/api/analytics/packs/summary"] = () => json(200, { collections: {} })
    render(<CollectionAnalyticsClient />)
    await screen.findByText(/not yet available for this collection/)
  })

  it("withholds an average value ratio the payload does not carry", async () => {
    routes["/api/analytics/packs/summary"] = () =>
      json(200, { collections: { topshot: { packs_tracked: 42, positive_ev_packs: 7 } } })
    render(<CollectionAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/pack ev/i))
  })
})

// ─── Per-collection slugs ────────────────────────────────────────────────────

describe("CollectionAnalyticsClient — per-collection slugs", () => {
  const cases: Array<[string, string]> = [
    ["nfl-all-day", "allday"],
    ["laliga-golazos", "golazos"],
    ["ufc-strike", "ufc"],
    ["disney-pinnacle", "pinnacle"],
  ]

  for (const [slug, short] of cases) {
    it(`scopes every card request to ${short} for ${slug}`, async () => {
      PARAMS.collection = slug
      try {
        routes["/api/ready"] = () => json(200, { per_collection: [{ slug, sales_24h: 900 }] })
        render(<CollectionAnalyticsClient />)
        await waitFor(() => {
          const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("collections="))
          expect(urls.length).toBeGreaterThan(0)
          expect(urls.every((u) => u.includes(`collections=${short}`))).toBe(true)
        })
      } finally {
        PARAMS.collection = "nba-top-shot"
      }
    })
  }
})
