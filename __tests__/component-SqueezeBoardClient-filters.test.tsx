// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, within, waitFor } from "@testing-library/react"

// Client-side filter coverage for SqueezeBoardClient. The populated-row pass
// rendered only the default (ALL / Any / Any) view; the tier + max-buyable +
// max-circulation controls drive a client-side `filtered` useMemo (rows are all
// present; the buttons never refetch — only sort/setFilter/playerFilter do), so
// each filter branch + the KPI recompute was dark. Anchor = per-row player name.

import SqueezeBoardClient from "@/app/insights/squeeze/SqueezeBoardClient"

const FETCHED = "2026-07-31T00:00:00Z"

function row(over: Record<string, unknown>) {
  return {
    edition_id: "e", external_id: "141:1", player_name: "P", set_name: "Base Set",
    tier: "COMMON", circulation: 1000, locked: 100, burned: 10, lock_pct: 10, burn_pct: 1,
    squeeze_pct: 11, effectively_buyable: 500, low_ask: 20, fmv_usd: 30, confidence: "HIGH",
    game_date: "2026-01-01", thumbnail_url: "https://example.com/a.png", ...over,
  }
}

const rows = [
  row({ edition_id: "l", external_id: "141:2", player_name: "Legend Guy", tier: "LEGENDARY", circulation: 99, effectively_buyable: 4 }),
  row({ edition_id: "u", external_id: "141:3", player_name: "Ultimate Guy", tier: "ULTIMATE", circulation: 8, effectively_buyable: 3 }),
  row({ edition_id: "c", external_id: "141:4", player_name: "Common Guy", tier: "COMMON", circulation: 15000, effectively_buyable: 500 }),
]

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve({ ok: true, json: async () => (String(url).includes("/api/profile/me") ? {} : { rows: [], meta: { fetched_at: FETCHED, total_rows: 0 } }) } as Response),
  ))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Drill-down tests mutate the URL (the component reads window.location on mount);
  // reset it so a leaked ?set=/?player= can't bleed into the next test's mount.
  window.history.replaceState({}, "", "/")
})

// A fetch stub whose /api/public/insights/squeeze response is configurable, so the
// refetch-on-control paths (sort change + set/player drill-down) can be driven and
// asserted. Everything else (rewards/track, profile/me) returns an inert 200.
function stubSqueezeFetch(squeeze: { rows: unknown[]; ok?: boolean; status?: number }) {
  const fn = vi.fn((url: string) => {
    if (String(url).includes("/api/public/insights/squeeze")) {
      if (squeeze.ok === false) {
        return Promise.resolve({ ok: false, status: squeeze.status ?? 500 } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ rows: squeeze.rows, meta: { fetched_at: FETCHED, total_rows: squeeze.rows.length } }),
      } as Response)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

function group(container: HTMLElement, ariaLabel: string): HTMLElement {
  const el = container.querySelector(`[aria-label="${ariaLabel}"]`)
  if (!el) throw new Error(`group "${ariaLabel}" not found`)
  return el as HTMLElement
}

describe("SqueezeBoardClient — client-side filters", () => {
  it("filters to a single tier via the tier pills", () => {
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    fireEvent.click(within(group(container, "Tier")).getByText("LEGENDARY"))
    expect(container.textContent).toMatch(/Legend Guy/)
    expect(container.textContent).not.toMatch(/Ultimate Guy/)
    expect(container.textContent).not.toMatch(/Common Guy/)

    fireEvent.click(within(group(container, "Tier")).getByText("ULTIMATE"))
    expect(container.textContent).toMatch(/Ultimate Guy/)
    expect(container.textContent).not.toMatch(/Legend Guy/)
  })

  it("filters by max effectively-buyable", () => {
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    // ≤ 5 keeps Legend(4) + Ultimate(3), drops Common(500)
    fireEvent.click(within(group(container, "Max effectively buyable")).getByText("≤ 5"))
    expect(container.textContent).toMatch(/Legend Guy/)
    expect(container.textContent).toMatch(/Ultimate Guy/)
    expect(container.textContent).not.toMatch(/Common Guy/)
  })

  // 2026-08-01 QA: the board printed a raw troll ask as if it were the market —
  // "2022-23 Season Rewind" LEGENDARY showed Low ask $5000k next to FMV $200
  // (25,000x). The view now flags low_ask > 10x FMV as `low_ask_disconnected`
  // and the cell renders an em-dash + "ask >> FMV" instead, WITHOUT dropping the
  // row (the QA requirement: never silently remove a row).
  describe("disconnected (troll) low ask", () => {
    const trollRows = [
      row({ edition_id: "t", external_id: "141:9", player_name: "Troll Ask Guy", tier: "LEGENDARY",
            low_ask: 5_000_000, fmv_usd: 200, low_ask_disconnected: true }),
      row({ edition_id: "n", external_id: "141:8", player_name: "Normal Guy", tier: "LEGENDARY",
            low_ask: 250, fmv_usd: 200, low_ask_disconnected: false }),
    ]

    it("never renders the troll number as a price", () => {
      const { container } = render(<SqueezeBoardClient initialRows={trollRows} initialFetchedAt={FETCHED} />)
      expect(container.textContent).not.toMatch(/5000k/)
      expect(container.textContent).not.toMatch(/\$5,000,000/)
    })

    it("keeps the row and flags it instead of dropping it", () => {
      const { container } = render(<SqueezeBoardClient initialRows={trollRows} initialFetchedAt={FETCHED} />)
      expect(container.textContent).toMatch(/Troll Ask Guy/)
      expect(container.querySelector(".rpc-sq-ask-flag")?.textContent).toMatch(/ask/i)
    })

    it("still exposes the listed number, but only as an explanation", () => {
      const { container } = render(<SqueezeBoardClient initialRows={trollRows} initialFetchedAt={FETCHED} />)
      const title = container.querySelector(".rpc-sq-ask-disconnected")?.getAttribute("title") ?? ""
      expect(title).toMatch(/10x/i)
      expect(title).toMatch(/not shown as a market price/i)
    })

    it("leaves a connected ask alone", () => {
      const { container } = render(<SqueezeBoardClient initialRows={trollRows} initialFetchedAt={FETCHED} />)
      expect(container.textContent).toMatch(/\$250/)
    })

    it("states the 10x rule on the page so nothing is hidden silently", () => {
      const { container } = render(<SqueezeBoardClient initialRows={trollRows} initialFetchedAt={FETCHED} />)
      expect(container.textContent).toMatch(/10.{0,3}. this edition.{0,3}s FMV/i)
    })
  })

  it("filters by max circulation (trophy-scarce)", () => {
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    // ≤ 10 (Ultimate) keeps only Ultimate(circ 8)
    fireEvent.click(within(group(container, "Max circulation")).getByText(/≤ 10 \(Ultimate\)/))
    expect(container.textContent).toMatch(/Ultimate Guy/)
    expect(container.textContent).not.toMatch(/Legend Guy/)
    expect(container.textContent).not.toMatch(/Common Guy/)
  })
})

// The refetch useEffect is skipped on the default view (sort=squeeze, no drill-down),
// so the populated + client-filter passes never touched it. A sort change or a
// set/player drill-down is the only thing that hits the server round-trip, its loading
// swap, the error path, and the min_squeeze=50-vs-0 branch.
describe("SqueezeBoardClient — refetch on sort", () => {
  it("refetches with the new sort param and swaps the returned rows in", async () => {
    const fetchMock = stubSqueezeFetch({
      rows: [row({ edition_id: "s", external_id: "141:7", player_name: "Sorted Guy" })],
    })
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    fireEvent.change(container.querySelector(".rpc-sq-select")!, { target: { value: "fmv" } })
    await waitFor(() => expect(container.textContent).toMatch(/Sorted Guy/))
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/public/insights/squeeze"))
    expect(String(call?.[0])).toMatch(/sort=fmv/)
    // No drill-down → the "squeeze board" 50% floor is applied.
    expect(String(call?.[0])).toMatch(/min_squeeze=50/)
  })

  it("shows the error state when the refetch fails", async () => {
    stubSqueezeFetch({ rows: [], ok: false, status: 503 })
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    fireEvent.change(container.querySelector(".rpc-sq-select")!, { target: { value: "buyable" } })
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load: HTTP 503/))
  })
})

describe("SqueezeBoardClient — set / player drill-down from the URL", () => {
  it("reads a set drill-down, shows the active-filter chip, and drops the squeeze floor to 0", async () => {
    window.history.replaceState({}, "", "/insights/squeeze?set=Base%20Set")
    const fetchMock = stubSqueezeFetch({
      rows: [row({ edition_id: "d", external_id: "141:7", player_name: "Drilled Guy", set_name: "Base Set" })],
    })
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    await waitFor(() => expect(container.querySelector(".rpc-sq-active-filter")).not.toBeNull())
    expect(container.textContent).toMatch(/FILTERED TO SET/)
    expect(container.querySelector(".rpc-sq-active-value")?.textContent).toBe("Base Set")
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/public/insights/squeeze"))
    // A drill-down drops min_squeeze to 0 so a low-squeeze member of the set is still visible.
    expect(String(call?.[0])).toMatch(/min_squeeze=0/)
    expect(String(call?.[0])).toMatch(/set=Base(\+|%20)Set/)
  })

  it("clears the set drill-down via the Clear button and scrubs the URL param", async () => {
    window.history.replaceState({}, "", "/insights/squeeze?set=Base%20Set")
    stubSqueezeFetch({ rows: [row({ edition_id: "d", player_name: "Drilled Guy", set_name: "Base Set" })] })
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    await waitFor(() => expect(container.querySelector(".rpc-sq-active-filter")).not.toBeNull())
    fireEvent.click(within(container.querySelector(".rpc-sq-active-filter")!).getByText(/Clear/))
    await waitFor(() => expect(container.querySelector(".rpc-sq-active-filter")).toBeNull())
    expect(window.location.search).not.toMatch(/set=/)
  })

  it("reads a player drill-down and clears it via its own Clear button", async () => {
    window.history.replaceState({}, "", "/insights/squeeze?player=Damian%20Lillard")
    stubSqueezeFetch({ rows: [row({ edition_id: "p", player_name: "Damian Lillard" })] })
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    await waitFor(() => expect(container.textContent).toMatch(/FILTERED TO PLAYER/))
    expect(container.querySelector(".rpc-sq-active-value")?.textContent).toBe("Damian Lillard")
    fireEvent.click(within(container.querySelector(".rpc-sq-active-filter")!).getByText(/Clear/))
    await waitFor(() => expect(container.querySelector(".rpc-sq-active-filter")).toBeNull())
    expect(window.location.search).not.toMatch(/player=/)
  })
})

describe("SqueezeBoardClient — table states + cells", () => {
  it("shows the empty state when the client filters exclude every row", () => {
    const one = [row({ edition_id: "only", player_name: "Only Common", tier: "COMMON" })]
    const { container } = render(<SqueezeBoardClient initialRows={one} initialFetchedAt={FETCHED} />)
    fireEvent.click(within(group(container, "Tier")).getByText("LEGENDARY"))
    expect(container.textContent).toMatch(/No editions match those filters/i)
  })

  it("falls back to the set name (and drops the duplicate line) when player_name is null", () => {
    const teamReel = [row({ edition_id: "np", external_id: null, player_name: null, set_name: "Team Reel" })]
    const { container } = render(<SqueezeBoardClient initialRows={teamReel} initialFetchedAt={FETCHED} />)
    expect(container.querySelector(".rpc-sq-edition-name")?.textContent).toBe("Team Reel")
    expect(container.querySelector(".rpc-sq-edition-set")).toBeNull()
    // external_id absent → link falls back to /moment/<edition_id>
    expect(container.querySelector(".rpc-sq-edition-link")?.getAttribute("href")).toMatch(/\/moment\/np/)
  })

  it("shows the set as a secondary line and links to the edition page when both fields exist", () => {
    const both = [row({ edition_id: "e7", external_id: "141:7", player_name: "Dame", set_name: "Base Set" })]
    const { container } = render(<SqueezeBoardClient initialRows={both} initialFetchedAt={FETCHED} />)
    expect(container.querySelector(".rpc-sq-edition-set")?.textContent).toBe("Base Set")
    expect(container.querySelector(".rpc-sq-edition-link")?.getAttribute("href")).toMatch(
      /\/nba-top-shot\/edition\/141%3A7/,
    )
  })

  it("formats k-scale currency and em-dashes absent numbers", () => {
    const mixed = [
      row({ edition_id: "big", player_name: "Big", fmv_usd: 15000, low_ask: 1500 }),
      row({ edition_id: "hund", player_name: "Hundreds", fmv_usd: 150, low_ask: null,
            circulation: null, locked: null, burned: null, squeeze_pct: null, effectively_buyable: null }),
    ]
    const { container } = render(<SqueezeBoardClient initialRows={mixed} initialFetchedAt={FETCHED} />)
    const text = container.textContent ?? ""
    expect(text).toMatch(/\$15k/)   // 15000 → 0-dp k
    expect(text).toMatch(/\$1\.5k/) // 1500 → 1-dp k
    expect(text).toMatch(/\$150\b/) // >= 100 → 0-dp dollars
    expect(text).toMatch(/—/)       // null low_ask / circ / squeeze render as em-dash
  })

  it("colours every tier chip and collapses the MOMENT_TIER_ vocabulary", () => {
    const tiers = [
      row({ edition_id: "r", player_name: "Rare Guy", tier: "RARE" }),
      row({ edition_id: "f", player_name: "Fandom Guy", tier: "FANDOM" }),
      row({ edition_id: "x", player_name: "No Tier Guy", tier: null }),
      row({ edition_id: "m", player_name: "Dirty Tier Guy", tier: "MOMENT_TIER_LEGENDARY" }),
    ]
    const { container } = render(<SqueezeBoardClient initialRows={tiers} initialFetchedAt={FETCHED} />)
    const chips = [...container.querySelectorAll(".rpc-sq-tier-chip")].map((c) => c.textContent)
    expect(chips).toContain("RARE")
    expect(chips).toContain("FANDOM")
    expect(chips).toContain("—") // null tier
    expect(chips).toContain("LEGENDARY") // MOMENT_TIER_LEGENDARY collapses to canonical
  })
})

describe("SqueezeBoardClient — the rewards earn only fires for a signed-in viewer (2026-09-04)", () => {
  it("anonymous: asks /api/profile/me, sees { user: null }, and never POSTs /api/rewards/track (was a 401 console error per anon load)", async () => {
    const fn = vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({ user: null }) } as Response)
      return Promise.resolve({ ok: true, json: async () => ({ rows: [], meta: { fetched_at: FETCHED, total_rows: 0 } }) } as Response)
    })
    vi.stubGlobal("fetch", fn)
    render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes("/api/profile/me"))).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(fn.mock.calls.some((c) => String(c[0]).includes("/api/rewards/track"))).toBe(false)
  })

  it("signed in: fires the view_squeeze earn once", async () => {
    const fn = vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) return Promise.resolve({ ok: true, json: async () => ({ user: { id: "u1" } }) } as Response)
      return Promise.resolve({ ok: true, json: async () => ({ rows: [], meta: { fetched_at: FETCHED, total_rows: 0 } }) } as Response)
    })
    vi.stubGlobal("fetch", fn)
    render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes("/api/rewards/track"))).toBe(true))
    const call = fn.mock.calls.find((c) => String(c[0]).includes("/api/rewards/track")) as unknown as [string, RequestInit]
    const body = String(call[1].body)
    expect(body).toContain("view_squeeze")
  })
})
