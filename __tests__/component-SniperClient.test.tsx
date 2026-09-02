// @vitest-environment jsdom
//
// __tests__/component-SniperClient.test.tsx
//
// The per-collection Sniper feed — the last big client page outside both
// coverage gates, and the surface where a false claim costs money in the most
// direct way on the platform: it tells a collector what is underpriced.
//
// ⚠ THIS PAGE IS ALREADY HARDENED, and that is the point of the suite. Its
// honesty branches were each added by a named incident — the Verified-FMV gate
// blaming "your filters" for a filter nobody set, the listing-suggestions panel
// CONCLUDING that your moments are fairly priced out of a failed read, the
// relative-deals leg printing "Benchmark data may be too thin" when the fetch
// had thrown. Every one of them carries a comment saying so. What none of them
// had was a TEST: a source grep proves a string is present, never that the
// branch is reachable or that it precedes the empty state.
//
// So these cases are written to red if a refactor collapses any of those three
// states back together, not to discover a new defect.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"

// ── Routing ────────────────────────────────────────────────────────────────
let routeCollection = "nba-top-shot"
let searchParams = new URLSearchParams()
const routerReplace = vi.fn()
const routerPush = vi.fn()
vi.mock("next/navigation", () => ({
  useParams: () => ({ collection: routeCollection }),
  useRouter: () => ({ replace: routerReplace, push: routerPush, refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}))

// ── The feed hook. This is the seam the whole page hangs off, so the tests
// drive it directly rather than through fetch: `useWarmCache` owns the
// loading/data/error triple that every honesty branch below reads.
let warm: { data: unknown; loading: boolean; error: unknown; refresh: () => void } = {
  data: null,
  loading: false,
  error: null,
  refresh: vi.fn(),
}
/** Every key `useWarmCache` was called with, newest last — this IS the feed URL. */
const warmKeys: string[] = []
vi.mock("@/lib/warmup/WarmupContext", () => ({
  useWarmCache: (key: string) => {
    warmKeys.push(key)
    return warm
  },
}))

// ⚠ MUST BE A REAL-LOOKING FLOW ADDRESS. The owned-ids effect early-returns on
// `!key.startsWith("0x")` — a username cannot be used directly, it has to be
// resolved to an address first — so a placeholder like "owner-1" silently
// skips the whole fetch. The tests below then fail for a reason that has
// nothing to do with what they assert, and any test that only checks the board
// still renders passes VACUOUSLY.
const OWNER_KEY = "0xbd94cade097e50ac"
vi.mock("@/lib/owner-key", () => ({ getOwnerKey: () => "0xbd94cade097e50ac" }))
vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

// Heavy children that own their own data and are covered by their own suites.
vi.mock("@/app/insights/pack-sniper/PackSniperClient", () => ({
  default: ({ lockedCollection }: { lockedCollection: string }) => (
    <div data-testid="pack-sniper">packs:{lockedCollection}</div>
  ),
}))
vi.mock("@/components/MomentDetailModal", () => ({ default: () => <div /> }))

import SniperClient from "@/app/(collections)/[collection]/sniper/SniperClient"

/**
 * A feed row shaped like the real `SniperDeal`.
 *
 * ⚠ COPIED FROM `lib/sniper/types.ts`, NOT INVENTED. The first draft of this
 * fixture guessed `price` / `fmv` / `discountPct` / `serialNumber` /
 * `fmvConfidence`; the real fields are `askPrice` / `adjustedFmv` / `discount` /
 * `serial` / `confidence`. An invented shape does not error — the row simply
 * renders as blanks and every assertion about it fails while looking like a
 * missing element, which is a slow way to learn you tested nothing.
 *
 * `confidence: "HIGH"` matters beyond realism: `isVerifiedDeal` admits only
 * high/medium, so a row with any other confidence is hidden by the default-on
 * Verified-FMV gate and never reaches the table at all.
 */
function deal(over: Record<string, unknown> = {}) {
  return {
    flowId: "111",
    momentId: "m-111",
    editionKey: "48:1652",
    playerName: "Damian Lillard",
    teamName: "Portland Trail Blazers",
    setName: "Archive Set",
    seriesName: "Series 1",
    tier: "LEGENDARY",
    parallel: "",
    parallelId: 0,
    serial: 42,
    circulationCount: 1000,
    askPrice: 25,
    baseFmv: 100,
    adjustedFmv: 100,
    aspUsd: 95,
    daysSinceSale: 2,
    salesCount30d: 12,
    discount: 75,
    confidence: "HIGH",
    hasBadge: false,
    badgeSlugs: [],
    badgeLabels: [],
    badgePremiumPct: 0,
    serialMult: 1,
    isSpecialSerial: false,
    isJersey: false,
    serialSignal: null,
    thumbnailUrl: null,
    isLocked: false,
    updatedAt: new Date().toISOString(),
    packListingId: null,
    packName: null,
    packEv: null,
    packEvRatio: null,
    buyUrl: "https://nbatopshot.com/listing/111",
    listingResourceID: null,
    storefrontAddress: null,
    source: "topshot",
    ...over,
  }
}

function feed(over: Record<string, unknown> = {}) {
  return {
    deals: [deal()],
    tsCount: 1,
    flowtyCount: 0,
    lastRefreshed: new Date().toISOString(),
    ...over,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

// ⚠ jsdom does not implement `scrollIntoView`, and the deep-link effect calls
// it from inside a `requestAnimationFrame` — so the callback fires AFTER the
// test that scheduled it has finished, surfacing as an UNHANDLED ERROR that
// fails the whole run (exit 1) with no failing test and no coverage complaint.
// Vitest's own warning for this case is that it "might cause false positive
// tests": the error is attributed to whichever test happened to be running when
// the frame fired, not the one that scheduled it, which is why it read as a
// failure in a completely unrelated case.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}

beforeEach(() => {
  routeCollection = "nba-top-shot"
  searchParams = new URLSearchParams()
  warmKeys.length = 0
  routerReplace.mockReset()
  routerPush.mockReset()
  warm = { data: null, loading: false, error: null, refresh: vi.fn() }
  // Every auxiliary leg (owned ids, edition stats, relative deals, benchmarks,
  // the empty-sniper beacon) goes through fetch; default them to benign shapes
  // so a test only has to override the one it is about.
  fetchMock = vi.fn(async (input: unknown) => ({
    ok: true,
    status: 200,
    json: async () => {
      const u = String(input)
      if (u.startsWith("/api/owned-flow-ids")) return { ids: [] }
      if (u.startsWith("/api/relative-deals")) return { deals: [] }
      if (u.startsWith("/api/tier-pricing-benchmarks")) return { benchmarks: {} }
      return {}
    },
  }))
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
  // ⚠ localStorage is REAL here and the owned-ids effect caches into it for ten
  // minutes, so without this a test that runs after one which populated the
  // cache takes the early-return branch and never fetches at all — its
  // assertions then fail for a reason that has nothing to do with the case.
  // State leaking between tests, and it looks exactly like a broken effect.
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("SniperClient — a failed feed must not read as a quiet market", () => {
  it("renders FEED ERROR and NOT 'the floor is quiet' when the read failed", async () => {
    // ⚠ THE CORE PROPERTY. "THE FLOOR IS QUIET" is a claim about the MARKET;
    // a failed read only ever supports a claim about US. The empty state is
    // gated on `data`, so the two cannot both render — this reds if a refactor
    // relaxes that gate to `visibleDeals.length === 0`.
    warm = { data: null, loading: false, error: new Error("HTTP 503"), refresh: vi.fn() }
    render(<SniperClient />)

    expect(await screen.findByText(/FEED ERROR/i)).toBeTruthy()
    expect(screen.queryByText(/THE FLOOR IS QUIET/i)).toBeNull()
    expect(screen.queryByText(/No deals match your filters/i)).toBeNull()
  })

  it("renders the quiet-floor state ONLY on a successful, genuinely empty read", async () => {
    // The mirror direction. An empty board is an honest answer and must keep
    // reading as one — a fix that routes every empty state into "unavailable"
    // just moves the dishonesty and cries wolf on the system working.
    warm = { data: feed({ deals: [], tsCount: 0 }), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect(await screen.findByText(/THE FLOOR IS QUIET/i)).toBeTruthy()
    expect(screen.queryByText(/FEED ERROR/i)).toBeNull()
  })

  it("shows neither claim while the read is still in flight", () => {
    warm = { data: null, loading: true, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect(screen.queryByText(/THE FLOOR IS QUIET/i)).toBeNull()
    expect(screen.queryByText(/No deals match your filters/i)).toBeNull()
  })
})

describe("SniperClient — the Verified-FMV gate names the real cause", () => {
  it("blames the default-on gate, not 'your filters', when it is what hid the rows", async () => {
    // ⚠ deep-audit D4. On Top Shot the feed is dominated by ask-derived rows
    // where FMV *is* the ask, so the spread is 0% by construction and the gate
    // correctly rejects them. Telling the user to widen "your filters" points
    // them at a filter they never set, next to a KPI row reading 0 deals — a
    // live board with hundreds of listings reading as a dead market.
    warm = {
      data: feed({
        deals: [
          deal({ flowId: "1", confidence: "ASK_ONLY", discount: 0, adjustedFmv: 25, askPrice: 25 }),
          deal({ flowId: "2", confidence: "ASK_ONLY", discount: 0, adjustedFmv: 30, askPrice: 30 }),
        ],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)

    expect(await screen.findByText(/NO VERIFIED-FMV DEALS RIGHT NOW/i)).toBeTruthy()
    expect(screen.getByText(/hidden by/i)).toBeTruthy()
    expect(screen.queryByText(/No deals match your filters/i)).toBeNull()
  })

  it("offers a way to see them rather than only explaining why they are gone", async () => {
    warm = {
      data: feed({
        deals: [deal({ confidence: "ASK_ONLY", discount: 0, adjustedFmv: 25, askPrice: 25 })],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)

    const btn = await screen.findByRole("button", { name: /SHOW ASK-PRICED LISTINGS/i })
    fireEvent.click(btn)
    // Turning the gate off must actually surface the row it was hiding.
    await waitFor(() => expect(screen.queryByText(/NO VERIFIED-FMV DEALS/i)).toBeNull())
  })

  it("falls back to the plain filter copy when nothing was gate-hidden", async () => {
    // Not vacuous: proves the two empty states are genuinely distinct rather
    // than one string that happens to render either way.
    warm = { data: feed({ deals: [] }), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect(await screen.findByText(/No deals match your filters/i)).toBeTruthy()
    expect(screen.queryByText(/NO VERIFIED-FMV DEALS/i)).toBeNull()
  })
})

describe("SniperClient — the Moments|Packs sub-toggle", () => {
  it("shows the sub-nav and the moments feed by default on Top Shot", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    await waitFor(() => expect(screen.queryByTestId("pack-sniper")).toBeNull())
  })

  it("mounts the pack sniper LOCKED to this collection on ?section=packs", async () => {
    // ⚠ The lock is the contract. An unlocked mount would show All Day packs on
    // the Top Shot tab — a cross-collection answer wearing the right heading.
    searchParams = new URLSearchParams("section=packs")
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    const el = await screen.findByTestId("pack-sniper")
    expect(el.textContent).toBe("packs:nba-top-shot")
  })

  it("honours ?section=packs on All Day too", async () => {
    routeCollection = "nfl-all-day"
    searchParams = new URLSearchParams("section=packs")
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect((await screen.findByTestId("pack-sniper")).textContent).toBe("packs:nfl-all-day")
  })

  it("IGNORES ?section=packs on a collection with no pack data", async () => {
    // ⚠ Only Top Shot and All Day have sealed-pack deal data. A hand-edited or
    // shared URL must not mount an empty pack board on Golazos and present it
    // as "no pack deals" — that is a claim about a market we do not index.
    routeCollection = "laliga-golazos"
    searchParams = new URLSearchParams("section=packs")
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    await waitFor(() => expect(screen.queryByTestId("pack-sniper")).toBeNull())
  })
})

describe("SniperClient — the feed request carries the filters", () => {
  it("builds a feed URL scoped to the collection it is mounted on", async () => {
    // ⚠ ASSERTS THE REQUEST, NOT A CALL COUNT. The first version of this case
    // counted fetches and OR'd two loose conditions — a "count of everything"
    // assertion, which is a clock measurement dressed up as a property and
    // passes for reasons unrelated to the thing under test. The feed goes
    // through `useWarmCache`, so its KEY is the observable, and a feed built
    // for the wrong collection is a whole board of wrong answers under a
    // correct heading.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    await waitFor(() => expect(warmKeys.length).toBeGreaterThan(0))
    expect(warmKeys[warmKeys.length - 1]).toContain("collection=")
    expect(warmKeys[warmKeys.length - 1]).toMatch(/nba-top-shot|topshot/)
  })

  it("rebuilds the feed URL for a DIFFERENT collection", async () => {
    // Not vacuous: proves the assertion above is about this collection rather
    // than about a constant that happens to contain the string.
    routeCollection = "nfl-all-day"
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    await waitFor(() => expect(warmKeys.length).toBeGreaterThan(0))
    const key = warmKeys[warmKeys.length - 1]
    expect(key).toMatch(/nfl-all-day|allday/)
    expect(key).not.toMatch(/nba-top-shot/)
  })

  it("renders a deal row with its player and set", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })
})

describe("SniperClient — the relative-deals leg reports a failure as a failure", () => {
  // This panel only exists for the ASK_ONLY collections (Golazos, UFC) and only
  // when the main feed came back genuinely empty — that combination is what the
  // fixtures below set up.
  const failureCopy = /Couldn't load relative deals/i
  const thinCopy = /Benchmark data may be too thin/i

  function mountGolazosWithRelative(relImpl: (u: string) => Promise<unknown>) {
    routeCollection = "laliga-golazos"
    warm = { data: feed({ deals: [], tsCount: 0 }), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/relative-deals")) return relImpl(u)
      return { ok: true, status: 200, json: async () => ({ benchmarks: {} }) }
    })
    render(<SniperClient />)
  }

  it("a 200 whose body has NO deals array is a failure, not an empty benchmark", async () => {
    // ⚠ THIS IS THE CASE THAT MAKES THE `Array.isArray` GUARD LOAD-BEARING, and
    // the two below CANNOT reach it. On a non-2xx or a thrown fetch, `rel` is
    // null and the mapping throws, so the outer catch sets the failure flag
    // anyway — deleting the guard changes nothing observable and the mutation
    // survives. Only a 200 carrying the wrong shape reaches the guard as the
    // sole thing standing between a failed read and "benchmark data may be too
    // thin" — a DIAGNOSIS of a cause that is not the cause.
    mountGolazosWithRelative(async () => ({ ok: true, status: 200, json: async () => ({ error: "upstream refused" }) }))

    expect(await screen.findByText(failureCopy)).toBeTruthy()
    expect(screen.queryByText(thinCopy)).toBeNull()
  })

  it("a non-2xx reports the failure copy", async () => {
    mountGolazosWithRelative(async () => ({ ok: false, status: 503, json: async () => ({}) }))

    expect(await screen.findByText(failureCopy)).toBeTruthy()
    expect(screen.queryByText(thinCopy)).toBeNull()
  })

  it("a THROWN fetch reports the failure copy", async () => {
    mountGolazosWithRelative(async () => {
      throw new Error("offline")
    })

    expect(await screen.findByText(failureCopy)).toBeTruthy()
    expect(screen.queryByText(thinCopy)).toBeNull()
  })

  it("a genuine empty benchmark still says so — the mirror direction", async () => {
    // Not vacuous, and it is the half that keeps the fix honest: a successful
    // read returning zero deals IS thin benchmark data, and must keep reading
    // that way rather than being swept into the failure copy.
    mountGolazosWithRelative(async () => ({ ok: true, status: 200, json: async () => ({ deals: [] }) }))

    expect(await screen.findByText(thinCopy)).toBeTruthy()
    expect(screen.queryByText(failureCopy)).toBeNull()
  })
})

describe("SniperClient — Listing Suggestions never CONCLUDE from a failed read", () => {
  // ⚠ THE STRONGEST CLAIM ON THE PAGE. "Your moments are priced at or below
  // current market asks" is a specific analytical statement about the reader's
  // own portfolio, and it is actionable toward INACTION — it tells them not to
  // re-list, which is the quietest possible harm: they do nothing and never
  // learn why. Three paths reach that panel with no comparison having happened,
  // and each must say so instead.
  const conclusion = /priced at or below current market asks/i

  function openSuggestions() {
    fireEvent.click(screen.getByRole("button", { name: /Listing Suggestions/i }))
  }

  it("a non-2xx collection read says so, and does NOT conclude", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("/api/collection-snapshot")) {
        return { ok: false, status: 503, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    openSuggestions()

    expect(await screen.findByText(/Couldn.t read your collection/i)).toBeTruthy()
    expect(screen.queryByText(conclusion)).toBeNull()
  })

  it("a THROWN collection read reaches the same honest state by the other route", async () => {
    // `fetch` throws on a network failure rather than resolving non-ok, so the
    // `.catch` is a second, independent path to the same false conclusion.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("/api/collection-snapshot")) throw new Error("offline")
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    openSuggestions()

    expect(await screen.findByText(/Couldn.t read your collection/i)).toBeTruthy()
    expect(screen.queryByText(conclusion)).toBeNull()
  })

  it("a read that SUCCEEDS with nothing to suggest DOES conclude — the mirror", async () => {
    // Not vacuous, and it is what keeps the fix honest: when both sides really
    // loaded and the comparison really ran, the conclusion is a true and useful
    // answer. Routing it into a failure notice is the mirror-image defect.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("/api/collection-snapshot")) {
        return { ok: true, status: 200, json: async () => ({ topMoments: [] }) }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    openSuggestions()

    expect(await screen.findByText(conclusion)).toBeTruthy()
    expect(screen.queryByText(/Couldn.t read your collection/i)).toBeNull()
  })

  it("closes again from the panel's own dismiss control", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("/api/collection-snapshot")) {
        return { ok: true, status: 200, json: async () => ({ topMoments: [] }) }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    openSuggestions()
    await screen.findByText(conclusion)

    fireEvent.click(screen.getByRole("button", { name: "✕" }))
    await waitFor(() => expect(screen.queryByText(conclusion)).toBeNull())
  })
})

describe("SniperClient — the auto-refresh controls", () => {
  it("pauses and resumes the countdown", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    const pause = await screen.findByRole("button", { name: /⏸/ })
    fireEvent.click(pause)
    expect(await screen.findByRole("button", { name: /▶ RESUME/i })).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /▶ RESUME/i }))
    expect(await screen.findByRole("button", { name: /⏸/ })).toBeTruthy()
  })

  it("REFRESH asks the cache to refetch", async () => {
    const refresh = vi.fn()
    warm = { data: feed(), loading: false, error: null, refresh }
    render(<SniperClient />)

    fireEvent.click(await screen.findByRole("button", { name: /↻ REFRESH/i }))
    expect(refresh).toHaveBeenCalled()
  })

  it("disables REFRESH while a read is already in flight", async () => {
    // Two concurrent reads of the same feed is wasted work against a pool that
    // is the platform's documented saturation constraint.
    warm = { data: feed(), loading: true, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    const btn = (await screen.findByRole("button", { name: "↻" })) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

describe("SniperClient — the filter controls reach the feed request", () => {
  // A filter that silently fails to be SENT does not error: the board keeps
  // showing unfiltered rows while the control reads as applied, which is a
  // wrong answer wearing a right one's clothes. Every server-side filter here
  // is asserted at the request, not at the widget.
  function lastKey() {
    return warmKeys[warmKeys.length - 1]
  }

  beforeEach(() => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
  })

  it("a tier change is sent", async () => {
    render(<SniperClient />)
    await waitFor(() => expect(warmKeys.length).toBeGreaterThan(0))
    const before = lastKey()

    fireEvent.click(screen.getByRole("button", { name: /^LEGENDARY$/i }))
    await waitFor(() => expect(lastKey()).not.toBe(before))
    expect(lastKey().toLowerCase()).toContain("legendary")
  })

  it("a max-price change is sent", async () => {
    render(<SniperClient />)
    await waitFor(() => expect(warmKeys.length).toBeGreaterThan(0))

    fireEvent.change(screen.getByPlaceholderText("any"), { target: { value: "50" } })
    await waitFor(() => expect(lastKey()).toMatch(/maxPrice=50/))
  })

  it("a min-discount change is sent", async () => {
    render(<SniperClient />)
    await waitFor(() => expect(warmKeys.length).toBeGreaterThan(0))

    fireEvent.change(screen.getByPlaceholderText("0"), { target: { value: "40" } })
    await waitFor(() => expect(lastKey()).toMatch(/minDiscount=40/))
  })

  it("the player filter is DEBOUNCED — a keystroke does not fire a request", async () => {
    // ⚠ The player box is server-side, so an un-debounced change would fire one
    // feed request per character against the pool this platform is documented
    // as being saturation-bound on.
    render(<SniperClient />)
    await waitFor(() => expect(warmKeys.length).toBeGreaterThan(0))
    const before = lastKey()

    fireEvent.change(screen.getByPlaceholderText("e.g. LeBron"), { target: { value: "Lillard" } })
    // Immediately after the keystroke the request must be unchanged.
    expect(lastKey()).toBe(before)

    await waitFor(() => expect(lastKey()).toMatch(/player=Lillard/i), { timeout: 2000 })
  })

  it("the free-text search is CLIENT-side and does not re-request", async () => {
    // Recorded because it is the one control that behaves differently, and
    // asserting it at the request would pin the wrong contract.
    render(<SniperClient />)
    await waitFor(() => expect(warmKeys.length).toBeGreaterThan(0))
    const before = lastKey()

    fireEvent.change(screen.getByPlaceholderText(/Search player, set, team/i), {
      target: { value: "zzz-no-such-player" },
    })
    await waitFor(() => expect(screen.queryByText(/No deals match your filters/i)).toBeTruthy())
    expect(lastKey()).toBe(before)
  })
})

describe("SniperClient — saving a search", () => {
  beforeEach(() => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
  })

  it("posts the ACTIVE filters, not an empty rule", async () => {
    // ⚠ A saved search that silently drops its filters is the alert-shaped
    // failure: the user is told it saved, and what was stored is broader (or
    // narrower) than the sentence that created it, with no screen on which the
    // error is ever visible.
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/watchlist") return { ok: true, status: 200, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.change(screen.getByPlaceholderText("any"), { target: { value: "50" } })
    fireEvent.click(await screen.findByRole("button", { name: /SAVE SEARCH/i }))

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/watchlist")).toBe(true)
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/watchlist")!
    const body = JSON.parse(String((call[1] as RequestInit).body))
    expect(body).toMatchObject({ type: "search", maxPrice: 50 })
    expect(await screen.findByText(/Saved!/i)).toBeTruthy()
  })

  it("a non-2xx says sign in rather than claiming it saved", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/watchlist") return { ok: false, status: 401, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await screen.findByRole("button", { name: /SAVE SEARCH/i }))

    expect(await screen.findByText(/Sign in to save searches/i)).toBeTruthy()
    expect(screen.queryByText(/Saved!/i)).toBeNull()
  })

  it("a THROWN save also does not claim success", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/watchlist") throw new Error("offline")
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await screen.findByRole("button", { name: /SAVE SEARCH/i }))

    expect(await screen.findByText(/Sign in to save searches/i)).toBeTruthy()
    expect(screen.queryByText(/Saved!/i)).toBeNull()
  })
})

describe("SniperClient — edition depth: two INDEPENDENT legs, two independent failures", () => {
  // Clicking a row expands "how deep is this edition" — a floor read and an
  // other-listings read. ⚠ They fail SEPARATELY and must report separately: a
  // failed floor leg beside a real listings list, or vice versa, is the state
  // this panel was rewritten for after a half-honest version rendered an
  // explicit floor error directly above a FABRICATED "no other listings".
  function row() {
    return document.querySelector("#sniper-row-111") as HTMLElement
  }

  beforeEach(() => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
  })

  it("renders both legs when both succeed", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) {
        return { ok: true, status: 200, json: async () => ({ topShotFloor: 20, topShotListingCount: 4 }) }
      }
      if (u.includes("editionKey=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deals: [deal({ flowId: "222", serial: 7, askPrice: 18 })] }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await waitFor(() => row()))

    expect(await screen.findByText(/OTHER LISTING/i)).toBeTruthy()
    expect(screen.getByText(/4 listed/i)).toBeTruthy()
  })

  it("a failed FLOOR leg does not suppress a good listings leg", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) return { ok: false, status: 503, json: async () => ({}) }
      if (u.includes("editionKey=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deals: [deal({ flowId: "222", serial: 7, askPrice: 18 })] }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await waitFor(() => row()))

    expect(await screen.findByText(/Could not load floor data/i)).toBeTruthy()
    expect(await screen.findByText(/OTHER LISTING/i)).toBeTruthy()
  })

  it("a failed LISTINGS leg says so instead of claiming there are none", async () => {
    // ⚠ THE ORDER IS THE PROPERTY, and the source comment says so: a failed
    // read leaves the list empty, so testing emptiness first swallows the
    // failure and prints "No other listings for this edition." — a claim about
    // the market manufactured from our own outage, on the panel a collector
    // uses to judge whether an ask is actually the cheapest.
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) {
        return { ok: true, status: 200, json: async () => ({ topShotFloor: 20, topShotListingCount: 4 }) }
      }
      if (u.includes("editionKey=")) return { ok: false, status: 503, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await waitFor(() => row()))

    expect(await screen.findByText(/Could not load other listings/i)).toBeTruthy()
    expect(screen.queryByText(/No other listings for this edition/i)).toBeNull()
  })

  it("a genuine zero still says there are none — the mirror direction", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) {
        return { ok: true, status: 200, json: async () => ({ topShotFloor: 20, topShotListingCount: 1 }) }
      }
      if (u.includes("editionKey=")) return { ok: true, status: 200, json: async () => ({ deals: [] }) }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await waitFor(() => row()))

    expect(await screen.findByText(/No other listings for this edition/i)).toBeTruthy()
    expect(screen.queryByText(/Could not load other listings/i)).toBeNull()
  })

  it("collapses again on a second click", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) return { ok: true, status: 200, json: async () => ({ topShotFloor: 20, topShotListingCount: 1 }) }
      if (u.includes("editionKey=")) return { ok: true, status: 200, json: async () => ({ deals: [] }) }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    const r = await waitFor(() => row())
    fireEvent.click(r)
    await screen.findByText(/No other listings for this edition/i)

    fireEvent.click(row())
    await waitFor(() => expect(screen.queryByText(/No other listings for this edition/i)).toBeNull())
  })
})

describe("SniperClient — the mobile tree is a SECOND rendering of the same rows", () => {
  // ⚠ This component renders two complete trees (a desktop table and mobile
  // cards) and the repo has already paid twice for them drifting — a mobile
  // branch with no empty state at all, and a P&L basis that showed a different
  // profit on a phone than on a desktop. So the mobile tree gets its own cases
  // rather than being assumed equivalent.
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 500, writable: true, configurable: true })
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
  })

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true })
  })

  it("renders the deal on a narrow viewport", async () => {
    render(<SniperClient />)
    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })

  it("shows the SAME quiet-floor empty state as the desktop tree", async () => {
    warm = { data: feed({ deals: [] }), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    expect(await screen.findByText(/THE FLOOR IS QUIET/i)).toBeTruthy()
  })

  it("still refuses to claim a quiet floor on a FAILED read", async () => {
    warm = { data: null, loading: false, error: new Error("HTTP 503"), refresh: vi.fn() }
    render(<SniperClient />)
    expect(await screen.findByText(/FEED ERROR/i)).toBeTruthy()
    expect(screen.queryByText(/THE FLOOR IS QUIET/i)).toBeNull()
  })
})

describe("SniperClient — the populated relative-deals table", () => {
  it("renders rows and tier benchmarks when both legs return data", async () => {
    routeCollection = "laliga-golazos"
    warm = { data: feed({ deals: [], tsCount: 0 }), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/relative-deals")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deals: [
              // ⚠ snake_case: the RelativeDeal interface in the client is
              // `player_name` / `ask_price` / `tier_median` / `discount_pct` /
              // `buy_url`, NOT the camelCase of `SniperDeal`. Two shapes with
              // different conventions in one file; a camelCase fixture renders
              // every cell as an em-dash and asserts nothing.
              {
                player_name: "Vinicius Jr",
                set_name: "Matchday",
                tier: "RARE",
                serial_number: 3,
                ask_price: 12,
                tier_median: 30,
                discount_pct: 60,
                fmv_usd: 30,
                confidence: "MEDIUM",
                buy_url: "https://example.test/listing/9",
              },
            ],
          }),
        }
      }
      if (u.startsWith("/api/tier-pricing-benchmarks")) {
        return { ok: true, status: 200, json: async () => ({ benchmarks: { RARE: { count: 12, floor: 8, median: 30 } } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [] }) }
    })
    render(<SniperClient />)

    expect(await screen.findByText(/Vinicius Jr/i)).toBeTruthy()
    expect(screen.queryByText(/Benchmark data may be too thin/i)).toBeNull()
  })
})

describe("SniperClient — the Fast Break deep link", () => {
  // A collector arrives here from a Fast Break card having clicked ONE specific
  // moment. ⚠ Between that click and this render the listing may have SOLD, and
  // the two outcomes are different messages: silently showing the generic board
  // would leave them hunting for a listing that no longer exists.
  function withHighlight(query: string) {
    Object.defineProperty(window, "location", {
      value: { ...window.location, search: query, href: `https://x/${query}` },
      writable: true,
      configurable: true,
    })
  }

  afterEach(() => {
    withHighlight("")
  })

  it("confirms the moment when it is still listed", async () => {
    withHighlight("?moment=m-111")
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect(await screen.findByRole("button", { name: /Dismiss Fast Break deep link/i })).toBeTruthy()
    expect(screen.queryByText(/was just removed/i)).toBeNull()
  })

  it("says the listing was REMOVED rather than silently showing the board", async () => {
    withHighlight("?moment=m-gone")
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect(await screen.findByText(/was just removed/i)).toBeTruthy()
  })

  it("dismisses the banner", async () => {
    withHighlight("?moment=m-gone")
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    fireEvent.click(await screen.findByRole("button", { name: /Dismiss Fast Break deep link/i }))

    await waitFor(() => expect(screen.queryByText(/was just removed/i)).toBeNull())
  })

  it("shows no banner at all without a deep link", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await waitFor(() => expect(screen.queryByRole("button", { name: /Dismiss Fast Break/i })).toBeNull())
  })
})

describe("SniperClient — polling pauses when nobody is looking", () => {
  it("stops the countdown and says so while the tab is hidden", async () => {
    // ⚠ Not cosmetic. This page polls its feed on an interval, and a background
    // tab left open all day is otherwise a steady request stream against the
    // pool this platform is documented as saturation-bound on.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await screen.findByRole("button", { name: /⏸/ })

    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true })
    fireEvent(document, new Event("visibilitychange"))

    expect(await screen.findByText(/Paused — tab hidden/i)).toBeTruthy()
  })

  it("resumes and refetches when the tab comes back", async () => {
    const refresh = vi.fn()
    warm = { data: feed(), loading: false, error: null, refresh }
    render(<SniperClient />)
    await screen.findByRole("button", { name: /⏸/ })

    Object.defineProperty(document, "hidden", { value: true, writable: true, configurable: true })
    fireEvent(document, new Event("visibilitychange"))
    await screen.findByText(/Paused — tab hidden/i)

    refresh.mockClear()
    Object.defineProperty(document, "hidden", { value: false, writable: true, configurable: true })
    fireEvent(document, new Event("visibilitychange"))

    // Coming back to a stale board is the whole reason to refetch on resume.
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Paused — tab hidden/i)).toBeNull())
  })

  it("Escape collapses an expanded edition-depth panel", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) return { ok: true, status: 200, json: async () => ({ topShotFloor: 20, topShotListingCount: 1 }) }
      if (u.includes("editionKey=")) return { ok: true, status: 200, json: async () => ({ deals: [] }) }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await waitFor(() => document.querySelector("#sniper-row-111") as HTMLElement))
    await screen.findByText(/No other listings for this edition/i)

    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByText(/No other listings for this edition/i)).toBeNull())
  })
})

describe("SniperClient — owned-moment gating", () => {
  it("reads the owner's flow ids and tolerates a non-array payload", async () => {
    // ⚠ `Array.isArray` rather than a truthiness check: an error body at HTTP
    // 200 would otherwise be `.map`-ed and throw during render. Owned-ids fails
    // SILENT on purpose — an empty set is the safe fallback, because the gate it
    // feeds only ever HIDES rows.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("/api/owned-flow-ids")) {
        return { ok: true, status: 200, json: async () => ({ ids: null, error: "nope" }) }
      }
      return { ok: true, status: 200, json: async () => ({ deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)

    // ⚠ Assert the REQUEST fired before asserting the consequence. The first
    // draft checked only that the board still rendered, which is true whether
    // or not the effect ever ran — it passed while the fetch was being skipped
    // entirely by the `0x` gate above.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/owned-flow-ids"))).toBe(true)
    })
    // The board still renders; the failure costs the owned filter, not the page.
    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })

  it("marks a deal the viewer already owns", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("/api/owned-flow-ids")) {
        return { ok: true, status: 200, json: async () => ({ ids: ["111"], editions: ["48:1652"] }) }
      }
      return { ok: true, status: 200, json: async () => ({ deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)

    const call = await waitFor(() => {
      const c = fetchMock.mock.calls.find((x) => String(x[0]).startsWith("/api/owned-flow-ids"))
      expect(c).toBeTruthy()
      return c!
    })
    expect(String(call[0])).toContain(encodeURIComponent(OWNER_KEY))
    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })
})

describe("SniperClient — a row navigates to the asset it names", () => {
  // ⚠ The href is DERIVED, not carried on the row: an edition page when we have
  // an edition key, else the serial-specific moment page. Sending a collector
  // to the wrong asset from a deal card is a wrong answer that looks like a
  // right one, and on a serial-keyed market the edition/serial distinction is
  // exactly the one that matters.
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 500, writable: true, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true })
  })

  it("routes to the EDITION page when the deal carries an edition key", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    const card = (await screen.findAllByText(/Damian Lillard/i))[0].closest(".rpc-card") as HTMLElement
    fireEvent.click(card)

    expect(routerPush).toHaveBeenCalledWith(
      `/nba-top-shot/edition/${encodeURIComponent("48:1652")}`,
    )
  })

  it("falls back to the MOMENT page when there is no edition key", async () => {
    warm = {
      data: feed({ deals: [deal({ editionKey: "" })] }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    const card = (await screen.findAllByText(/Damian Lillard/i))[0].closest(".rpc-card") as HTMLElement
    fireEvent.click(card)

    expect(routerPush).toHaveBeenCalledWith("/moment/111")
  })

  it("does NOT hijack a click on a link or button inside the card", async () => {
    // The card is one big click target, so a nested Buy link would otherwise be
    // swallowed by the card's own navigation and the user would never reach the
    // marketplace.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    const card = (await screen.findAllByText(/Damian Lillard/i))[0].closest(".rpc-card") as HTMLElement
    const inner = card.querySelector("a,button")
    if (inner) {
      routerPush.mockClear()
      fireEvent.click(inner)
      expect(routerPush).not.toHaveBeenCalled()
    }
  })
})

describe("SniperClient — badges render from the deal's own slugs", () => {
  it("renders badge chips when the deal carries them", async () => {
    warm = {
      data: feed({
        deals: [
          deal({
            hasBadge: true,
            badgeSlugs: ["rookie_year", "championship_year"],
            badgeLabels: ["Rookie Year", "Championship Year"],
            badgePremiumPct: 12,
          }),
        ],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)

    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })

  it("de-duplicates repeated slugs rather than drawing the same badge twice", async () => {
    // The render wraps the slugs in a Set before slicing, so a feed row that
    // repeats a slug does not produce two identical chips.
    warm = {
      data: feed({
        deals: [
          deal({
            hasBadge: true,
            badgeSlugs: ["rookie_year", "rookie_year", "rookie_year"],
            badgeLabels: ["Rookie Year"],
          }),
        ],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })
})

describe("SniperClient — a special serial is surfaced", () => {
  it("renders a jersey-match / special serial row", async () => {
    warm = {
      data: feed({
        deals: [deal({ isSpecialSerial: true, isJersey: true, serial: 0, serialSignal: "jersey_match" })],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })

  it("renders a LOCKED listing without crashing", async () => {
    warm = {
      data: feed({ deals: [deal({ isLocked: true })] }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })

  it("renders a pack-linked deal without crashing", async () => {
    warm = {
      data: feed({
        deals: [deal({ packListingId: "p-1", packName: "Base Set Pack", packEv: 40, packEvRatio: 1.6 })],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
  })
})

describe("SniperClient — a listing that SELLS between refreshes is called out", () => {
  // ⚠ The board polls, so a row can vanish under the reader's cursor. Silently
  // dropping it is the worst outcome on this page: they click through to buy a
  // moment that is already gone, and blame us for the dead link. The page
  // instead keeps the row briefly and marks it SOLD.
  it("marks a deal that disappeared from the next payload", async () => {
    const first = feed({ deals: [deal({ flowId: "111" }), deal({ flowId: "222", playerName: "CJ McCollum" })] })
    warm = { data: first, loading: false, error: null, refresh: vi.fn() }
    const { rerender } = render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    // Second poll: 222 is gone.
    warm = {
      data: feed({ deals: [deal({ flowId: "111" })] }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    rerender(<SniperClient />)

    // The vanished row is surfaced rather than silently removed.
    await waitFor(() => expect(screen.getByText(/SOLD|JUST SOLD/i)).toBeTruthy())
  })

  it("does NOT mark anything on the very first payload", async () => {
    // ⚠ The guard is `prevDealIdsRef.current.size > 0`. Without it the first
    // render would compare against an empty set and declare every deal on the
    // board sold — a fabricated signal at exactly the moment the user arrives.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    expect(screen.queryByText(/JUST SOLD/i)).toBeNull()
  })
})

describe("SniperClient — the desktop row's media and buy controls", () => {
  const withThumb = () =>
    feed({
      deals: [
        deal({
          thumbnailUrl: "https://assets.nbatopshot.com/x/width=256/img.jpg",
          buyUrl: "https://nbatopshot.com/listing/111",
        }),
      ],
    })

  it("swaps a 404ing thumbnail for a transparent placeholder, once", async () => {
    // ⚠ The DESKTOP handler substitutes a transparent GIF; the MOBILE one sets
    // display:none. Two trees, two different remedies — asserting the mobile
    // behaviour against the desktop tree fails on correct code, which is how
    // the first draft of this case went red.
    //
    // The `img.onerror = null` first is the load-bearing half: without it, a
    // placeholder that itself failed to load would re-enter the handler and
    // loop forever.
    warm = { data: withThumb(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    const img = document.querySelector('img[alt="Damian Lillard"]') as HTMLImageElement
    expect(img).toBeTruthy()
    fireEvent.error(img)
    expect(img.getAttribute("src") ?? "").toMatch(/^data:image\/gif;base64,/)
    expect(img.onerror).toBeNull()
  })

  it("the thumbnail brightens on hover and settles back", async () => {
    warm = { data: withThumb(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    const img = document.querySelector('img[alt="Damian Lillard"]') as HTMLImageElement
    const rest = img.style.boxShadow
    fireEvent.mouseOver(img)
    expect(img.style.boxShadow).not.toBe(rest)
    fireEvent.mouseOut(img)
    expect(img.style.boxShadow).toBe(rest)
  })

  it("the thumbnail navigates to the asset and stops the row from also firing", async () => {
    warm = { data: withThumb(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    const img = document.querySelector('img[alt="Damian Lillard"]') as HTMLImageElement
    routerPush.mockClear()
    fireEvent.click(img)
    expect(routerPush).toHaveBeenCalledWith(`/nba-top-shot/edition/${encodeURIComponent("48:1652")}`)
  })

  it("hovering a row and leaving it restores the resting background", async () => {
    warm = { data: withThumb(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    const row = (await waitFor(() => document.querySelector("#sniper-row-111"))) as HTMLElement

    fireEvent.mouseOver(row)
    const hovered = row.style.background
    fireEvent.mouseOut(row)
    expect(row.style.background).not.toBe(hovered)
  })

  it("records a click-through on the buy link", async () => {
    warm = { data: withThumb(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    const buy = Array.from(document.querySelectorAll("a")).find((a) =>
      (a.getAttribute("href") ?? "").includes("nbatopshot.com/listing/111"),
    )
    if (buy) {
      routerPush.mockClear()
      fireEvent.click(buy)
      // The row's own navigation must NOT fire — the user asked for the
      // marketplace, not our edition page.
      expect(routerPush).not.toHaveBeenCalled()
    }
  })
})

describe("SniperClient — populated listing suggestions", () => {
  it("lists each suggestion with its player and the gap to market", async () => {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/collection-snapshot")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            topMoments: [
              {
                editionKey: "48:1652",
                playerName: "Damian Lillard",
                serialNumber: 9,
                serial: 9,
                fmv: 10,
                fmvUsd: 10,
              },
            ],
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(screen.getByRole("button", { name: /Listing Suggestions/i }))

    // Either a suggestion renders, or the honest "nothing to suggest" copy
    // does — what must NEVER appear is the read-failed notice, because the read
    // succeeded.
    await waitFor(() => expect(screen.queryByText(/Analyzing your portfolio/i)).toBeNull())
    expect(screen.queryByText(/Couldn.t read your collection/i)).toBeNull()
  })
})

describe("SniperClient — CLEAR FILTERS is a real escape hatch", () => {
  it("resets every filter, including the ones the user cannot see they set", async () => {
    // ⚠ The empty state offers this precisely because a collector who has
    // narrowed themselves into a blank board often cannot tell WHICH control
    // did it — the Verified-FMV gate is on by DEFAULT, so it is a filter they
    // never set. A reset that missed one would leave the board stubbornly empty
    // and read as a broken feature.
    warm = { data: feed({ deals: [] }), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)
    await screen.findByText(/THE FLOOR IS QUIET/i)

    fireEvent.change(screen.getByPlaceholderText("any"), { target: { value: "50" } })
    fireEvent.change(screen.getByPlaceholderText(/Search player, set, team/i), { target: { value: "zzz" } })

    fireEvent.click(screen.getByRole("button", { name: /CLEAR FILTERS/i }))

    await waitFor(() => {
      expect((screen.getByPlaceholderText("any") as HTMLInputElement).value).toBe("")
    })
    expect((screen.getByPlaceholderText(/Search player, set, team/i) as HTMLInputElement).value).toBe("")
  })

  it("the MOBILE filter toggle counts the active filters", async () => {
    // ⚠ MOBILE ONLY. `SniperFilterBar` renders this control behind `isMobile`,
    // so a desktop-width test cannot find it and fails against correct code.
    // The count is the point: on a narrow screen the filter panel is collapsed,
    // so without it a user has no way to see that three filters are narrowing
    // the board they are staring at.
    Object.defineProperty(window, "innerWidth", { value: 500, writable: true, configurable: true })
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    const toggle = await screen.findByRole("button", { name: /⚙ FILTERS/i })
    expect(toggle.textContent).not.toMatch(/\(\d\)/)

    fireEvent.click(toggle)
    fireEvent.change(screen.getByPlaceholderText("any"), { target: { value: "50" } })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /⚙ FILTERS \(1\)/i })).toBeTruthy(),
    )

    Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true })
  })
})

describe("SniperClient — the mobile card's own media and buy controls", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 500, writable: true, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true })
  })

  it("HIDES a 404ing thumbnail — the mobile remedy, not the desktop one", async () => {
    // ⚠ Deliberately asserted separately from the desktop case. The two trees
    // handle the same failure differently (display:none here, a transparent GIF
    // there), and this repo has already paid twice for the mobile tree drifting
    // from the desktop one unnoticed.
    warm = {
      data: feed({ deals: [deal({ thumbnailUrl: "https://assets.nbatopshot.com/x/img.jpg" })] }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    const img = document.querySelector('img[alt="Damian Lillard"]') as HTMLImageElement
    expect(img).toBeTruthy()
    fireEvent.error(img)
    expect(img.style.display).toBe("none")
  })

  it("a buy link records the click-through and does not also navigate in-app", async () => {
    warm = {
      data: feed({ deals: [deal({ buyUrl: "https://nbatopshot.com/listing/111" })] }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    await screen.findAllByText(/Damian Lillard/i)

    const link = Array.from(document.querySelectorAll("a")).find((a) =>
      /View Listing|Dapper/i.test(a.textContent ?? ""),
    )
    if (link) {
      routerPush.mockClear()
      fireEvent.click(link)
      expect(routerPush).not.toHaveBeenCalled()
    }
  })
})

describe("SniperClient — the depth panel orders other listings by price", () => {
  it("puts the cheapest other listing first", async () => {
    // ⚠ This panel exists to answer "is this ask actually the cheapest?", so an
    // unordered list answers a different question than the one being asked.
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) {
        return { ok: true, status: 200, json: async () => ({ topShotFloor: 12, topShotListingCount: 3 }) }
      }
      if (u.includes("editionKey=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deals: [
              deal({ flowId: "333", serial: 88, askPrice: 40 }),
              deal({ flowId: "222", serial: 7, askPrice: 12 }),
            ],
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(await waitFor(() => document.querySelector("#sniper-row-111") as HTMLElement))

    await screen.findByText(/2 OTHER LISTINGS/i)
    const serials = Array.from(document.querySelectorAll("span"))
      .map((s) => s.textContent ?? "")
      .filter((t) => t === "#7" || t === "#88")
    expect(serials[0]).toBe("#7")
  })
})

describe("SniperClient — the same feed under each collection's own vocabulary", () => {
  // ⚠ One component serves five collections and branches on them throughout:
  // Pinnacle swaps tier tabs for VARIANT tabs and relabels the board, All Day
  // resolves a different thumbnail width and tier palette, Golazos/UFC are the
  // ASK_ONLY pair. A render per collection is the cheapest way to keep a
  // collection-specific branch from rotting unnoticed — the per-collection
  // vocabulary mismatch is a documented recurring defect class in this repo.
  for (const slug of ["nba-top-shot", "nfl-all-day", "disney-pinnacle", "ufc", "laliga-golazos"]) {
    it(`renders for ${slug} without crashing, and still refuses to fake a quiet floor`, async () => {
      routeCollection = slug
      warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
      render(<SniperClient />)
      expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)

      cleanup()
      warm = { data: null, loading: false, error: new Error("HTTP 503"), refresh: vi.fn() }
      render(<SniperClient />)
      expect(await screen.findByText(/FEED ERROR/i)).toBeTruthy()
      expect(screen.queryByText(/THE FLOOR IS QUIET/i)).toBeNull()
    })
  }

  it("survives a deal whose optional fields are all null", async () => {
    // Feed rows arrive from five different indexers and the optional fields are
    // genuinely absent for some collections — a crash here takes the whole
    // board down, not one row.
    routeCollection = "disney-pinnacle"
    warm = {
      data: feed({
        deals: [
          deal({
            thumbnailUrl: null,
            updatedAt: null,
            aspUsd: null,
            daysSinceSale: null,
            salesCount30d: null,
            serialSignal: null,
            listingResourceID: null,
            storefrontAddress: null,
            playerName: "",
            setName: "",
            tier: "",
          }),
        ],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    // It renders SOMETHING rather than throwing; the initial-letter fallback is
    // "?" precisely so an empty name still produces a tile.
    await waitFor(() => expect(document.querySelector("#sniper-row-111")).toBeTruthy())
  })

  it("renders a zero-discount deal as ~0% rather than a negative-looking figure", async () => {
    warm = {
      data: feed({ deals: [deal({ discount: 0, askPrice: 100, adjustedFmv: 100, confidence: "HIGH" })] }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)
    expect((await screen.findAllByText(/~0%/)).length).toBeGreaterThan(0)
  })
})

describe("SniperClient — a fully-decorated row draws every chip it earns", () => {
  it("renders parallel, offer, lowest-ask, special-serial and pack chips together", async () => {
    // Each chip is an independent claim about the listing, and they are drawn
    // from separate optional fields — so one row carrying all of them is the
    // cheapest way to keep any single chip's condition from silently rotting.
    warm = {
      data: feed({
        deals: [
          deal({
            parallel: "Hexwave",
            parallelId: 3,
            offerAmount: 18,
            offerFmvPct: 18,
            isLowestAsk: true,
            isSpecialSerial: true,
            isJersey: false,
            serial: 44,
            serialSignal: "repdigit",
            packListingId: "p-1",
            packName: "Base Set Pack",
            packEv: 40,
            packEvRatio: 1.62,
            hasBadge: true,
            badgeSlugs: ["rookie_year"],
            badgeLabels: ["Rookie Year"],
            badgePremiumPct: 12,
          }),
        ],
      }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)

    await waitFor(() => expect(document.querySelector("#sniper-row-111")).toBeTruthy())
    const row = document.querySelector("#sniper-row-111") as HTMLElement
    expect(row.textContent).toMatch(/Hexwave/i)
  })

  it("suppresses the parallel chip for a Base printing", async () => {
    // Not vacuous: "Base" is the default printing, so labelling it would put a
    // parallel badge on essentially every Top Shot row and make the real ones
    // meaningless.
    warm = {
      data: feed({ deals: [deal({ parallel: "Base", parallelId: 0 })] }),
      loading: false,
      error: null,
      refresh: vi.fn(),
    }
    render(<SniperClient />)

    const row = (await waitFor(() => document.querySelector("#sniper-row-111"))) as HTMLElement
    expect(row.textContent).not.toMatch(/\bBase\b/)
  })
})

describe("SniperClient — the depth panel's floor variants", () => {
  function mountDepth(floor: Record<string, unknown>, others: unknown[] = []) {
    warm = { data: feed(), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/edition-floor")) return { ok: true, status: 200, json: async () => floor }
      if (u.includes("editionKey=")) return { ok: true, status: 200, json: async () => ({ deals: others }) }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
  }

  it("shows an em-dash rather than $0 when there is no Top Shot floor", async () => {
    // ⚠ A missing floor is NOT a floor of zero. Rendering $0.00 would present
    // the cheapest imaginable price for an edition we simply could not price.
    mountDepth({ topShotFloor: null, topShotListingCount: 0 })
    fireEvent.click(await waitFor(() => document.querySelector("#sniper-row-111") as HTMLElement))

    const panel = await screen.findByText(/TOP SHOT/i)
    expect(panel.parentElement?.textContent).toMatch(/—/)
    expect(panel.parentElement?.textContent).not.toMatch(/\$0\.00/)
  })

  it("renders the cross-market best floor and the LiveToken FMV when present", async () => {
    mountDepth({
      topShotFloor: 22,
      topShotListingCount: 5,
      crossMarketFloor: 19,
      crossMarketSource: "flowty",
      livetokenFmv: 31,
    })
    fireEvent.click(await waitFor(() => document.querySelector("#sniper-row-111") as HTMLElement))

    expect(await screen.findByText(/BEST FLOOR/i)).toBeTruthy()
    expect(screen.getByText(/LT FMV/i)).toBeTruthy()
  })

  it("renders a zero-discount other-listing as ~0% and names its marketplace", async () => {
    mountDepth({ topShotFloor: 22, topShotListingCount: 5 }, [
      deal({ flowId: "222", serial: 7, askPrice: 22, discount: 0, source: "flowty" }),
    ])
    fireEvent.click(await waitFor(() => document.querySelector("#sniper-row-111") as HTMLElement))

    await screen.findByText(/1 OTHER LISTING/i)
    expect(screen.getByText("~0%")).toBeTruthy()
    expect(screen.getByText("Flowty")).toBeTruthy()
  })
})

describe("SniperClient — suggestions before the market has loaded", () => {
  it("says it is WAITING on the feed rather than concluding from an unloaded one", async () => {
    // ⚠ The third honest state: the collection read succeeded but the deals
    // feed has not arrived, so no comparison happened. Concluding here would be
    // the same false claim reached by a third route.
    warm = { data: null, loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).startsWith("/api/collection-snapshot")) {
        return { ok: true, status: 200, json: async () => ({ topMoments: [{ editionKey: "48:1652", serial: 9 }] }) }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [], deals: [], benchmarks: {} }) }
    })
    render(<SniperClient />)
    fireEvent.click(screen.getByRole("button", { name: /Listing Suggestions/i }))

    expect(await screen.findByText(/Waiting on the live listings feed/i)).toBeTruthy()
    expect(screen.queryByText(/priced at or below current market asks/i)).toBeNull()
  })
})

describe("SniperClient — relative deals with missing fields", () => {
  it("renders em-dashes rather than fabricating names or prices", async () => {
    routeCollection = "ufc"
    warm = { data: feed({ deals: [], tsCount: 0 }), loading: false, error: null, refresh: vi.fn() }
    fetchMock.mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.startsWith("/api/relative-deals")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deals: [
              {
                player_name: null,
                set_name: null,
                tier: null,
                serial_number: null,
                ask_price: null,
                tier_median: null,
                discount_pct: null,
                fmv_usd: null,
                confidence: null,
                buy_url: null,
              },
            ],
          }),
        }
      }
      if (u.startsWith("/api/tier-pricing-benchmarks")) {
        return { ok: true, status: 200, json: async () => ({ benchmarks: { FANDOM: { count: 3, floor: null, median: null } } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ids: [] }) }
    })
    render(<SniperClient />)

    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0))
  })
})

describe("SniperClient — a 200 whose SOURCES failed is not a quiet market either", () => {
  // ⚠ The gap the block at the top of this file did NOT cover. Those cases pin
  // the `data == null && error` shape — a fetch that failed outright. But every
  // deal-bearing read inside /api/sniper-feed used to collapse to an empty list
  // on failure and the route still answered 200, so `data` arrived NON-null with
  // `deals: []` and the board printed the quiet-floor conclusion. Live evidence,
  // 2026-09-02: four users hit `AD GQL FAILED: HTTP 403` in 24h.
  //
  // `sourcesFailed` closes it: empty means we actually looked.
  //
  // These render through the mocked `useWarmCache`, so what appears is computed
  // from `data` on the first pass — there is no mount effect to correct the
  // state afterwards, which is the condition that would otherwise force an SSR
  // assertion here.

  it("does not print the quiet-floor conclusion when a source failed", async () => {
    warm = {
      data: feed({ deals: [], tsCount: 0, sourcesFailed: ["allday-marketplace"], degraded: true }),
      loading: false, error: null, refresh: vi.fn(),
    }
    render(<SniperClient />)

    expect(await screen.findByText(/COULDN'T LOAD THE FLOOR/i)).toBeTruthy()
    expect(screen.queryByText(/THE FLOOR IS QUIET/i)).toBeNull()
    expect(screen.queryByText(/No deals match your filters/i)).toBeNull()
    expect(screen.queryByText(/widening your search/i)).toBeNull()
  })

  it("reports the failed read instead of diagnosing the reader's filters", async () => {
    warm = {
      data: feed({ deals: [], tsCount: 0, sourcesFailed: ["ts_listings"], degraded: true }),
      loading: false, error: null, refresh: vi.fn(),
    }
    render(<SniperClient />)

    expect(await screen.findByText(/Couldn't reach the listing feed/i)).toBeTruthy()
  })

  it("offers RETRY, not CLEAR FILTERS — clearing filters cannot recover a failed read", async () => {
    // ⚠ The button is the diagnosis in another form. Leaving CLEAR FILTERS as
    // the only escape hatch tells the reader their filters are why the board is
    // blank, which is exactly the false claim the copy above stopped making.
    const refresh = vi.fn()
    warm = {
      data: feed({ deals: [], tsCount: 0, sourcesFailed: ["topshot-deals-rpc"], degraded: true }),
      loading: false, error: null, refresh,
    }
    render(<SniperClient />)
    await screen.findByText(/COULDN'T LOAD THE FLOOR/i)

    expect(screen.queryByRole("button", { name: /CLEAR FILTERS/i })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /^RETRY$/i }))
    expect(refresh).toHaveBeenCalled()
  })

  it("NO-CHANGE CONTROL: sourcesFailed empty still reads as a genuinely quiet floor", async () => {
    // The mirror direction. Routing every empty board into "couldn't load"
    // would just move the dishonesty and cry wolf on the system working.
    warm = {
      data: feed({ deals: [], tsCount: 0, sourcesFailed: [], degraded: false }),
      loading: false, error: null, refresh: vi.fn(),
    }
    render(<SniperClient />)

    expect(await screen.findByText(/THE FLOOR IS QUIET/i)).toBeTruthy()
    expect(await screen.findByText(/No deals match your filters/i)).toBeTruthy()
    expect(screen.queryByText(/COULDN'T LOAD THE FLOOR/i)).toBeNull()
    expect(screen.getByRole("button", { name: /CLEAR FILTERS/i })).toBeTruthy()
  })

  it("NO-CHANGE CONTROL: a response predating the field is not reported as degraded", async () => {
    // A cached 200 from before this shipped carries no `sourcesFailed`. Treating
    // absence as failure would make every warm response cry wolf.
    warm = { data: feed({ deals: [], tsCount: 0 }), loading: false, error: null, refresh: vi.fn() }
    render(<SniperClient />)

    expect(await screen.findByText(/THE FLOOR IS QUIET/i)).toBeTruthy()
    expect(screen.queryByText(/COULDN'T LOAD THE FLOOR/i)).toBeNull()
  })

  it("a degraded feed that still returned rows renders them — partial is not empty", async () => {
    // The All Day GQL falling over drops us onto the edition-level RPC, which
    // often DOES return rows. Those rows are real and must still show; the
    // degraded copy belongs to the empty state only.
    warm = {
      data: feed({ deals: [deal()], tsCount: 1, sourcesFailed: ["allday-marketplace"], degraded: true }),
      loading: false, error: null, refresh: vi.fn(),
    }
    render(<SniperClient />)

    expect((await screen.findAllByText(/Damian Lillard/i)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/COULDN'T LOAD THE FLOOR/i)).toBeNull()
  })
})
