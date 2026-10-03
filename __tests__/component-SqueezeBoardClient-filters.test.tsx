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

// ⚠ RE-PINNED 2026-09-25 (known-issues #146). These tests used to assert the
// filters ran CLIENT-SIDE over the already-fetched 200 rows — which was the
// defect: the board holds ~5,600 editions at >=50% squeeze, so "Legendary" showed
// only the Legendaries that ranked in the overall top 200 and could conclude "No
// editions match". Each control now REFETCHES with its parameter; the stub below
// plays the server (it filters by the params it receives), so every test pins
// both that the parameter is SENT and that the server's answer is what renders.
function stubServerFiltering(all: ReturnType<typeof row>[]) {
  const fn = vi.fn((url: string) => {
    const u = new URL(String(url), "https://t")
    if (!u.pathname.includes("/api/public/insights/squeeze")) {
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    }
    const tier = u.searchParams.get("tier")
    const maxB = u.searchParams.get("max_buyable")
    const maxC = u.searchParams.get("max_circulation")
    const minC = u.searchParams.get("min_circulation")
    const minB = u.searchParams.get("min_buyable")
    const team = u.searchParams.get("team")
    // The server resolves a typed team to the FRANCHISE's labels; this stub
    // plays that: "clippers" → both Clippers labels, anything else → none.
    const labels = team == null ? null : /clippers/i.test(team) ? ["LA Clippers", "Los Angeles Clippers"] : []
    const out = all.filter((r) =>
      (!tier || r.tier === tier) &&
      (maxB == null || (r.effectively_buyable as number) <= Number(maxB)) &&
      (maxC == null || (r.circulation as number) <= Number(maxC)) &&
      (minC == null || (r.circulation as number) >= Number(minC)) &&
      (minB == null || (r.effectively_buyable as number) >= Number(minB)) &&
      (labels == null || labels.includes(String((r as { team_name?: string }).team_name))))
    const team_resolution = team == null ? null : labels!.length > 0 ? { status: "one", current_name: "LA Clippers", labels: labels!.length } : { status: "none", current_name: null, labels: 0 }
    return Promise.resolve({ ok: true, json: async () => ({ rows: out, meta: { fetched_at: FETCHED, total_rows: out.length, filters: { team, team_resolution } } }) } as Response)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}
const squeezeCalls = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => new URL(String(c[0]), "https://t")).filter((u) => u.pathname.includes("/api/public/insights/squeeze"))

describe("SqueezeBoardClient — filters are sent to the server", () => {
  it("filters to a single tier via the tier pills", async () => {
    const fn = stubServerFiltering(rows)
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    fireEvent.click(within(group(container, "Tier")).getByText("LEGENDARY"))
    await waitFor(() => expect(container.textContent).not.toMatch(/Common Guy/))
    expect(squeezeCalls(fn).at(-1)?.searchParams.get("tier")).toBe("LEGENDARY")
    expect(container.textContent).toMatch(/Legend Guy/)
    expect(container.textContent).not.toMatch(/Ultimate Guy/)

    fireEvent.click(within(group(container, "Tier")).getByText("ULTIMATE"))
    await waitFor(() => expect(container.textContent).toMatch(/Ultimate Guy/))
    expect(squeezeCalls(fn).at(-1)?.searchParams.get("tier")).toBe("ULTIMATE")
    expect(container.textContent).not.toMatch(/Legend Guy/)
  })

  it("a tier the top-200 window did NOT contain still comes back from the server", async () => {
    // The initial (default-view) rows hold no Ultimate at all; the server does.
    const initial = rows.filter((r) => r.tier !== "ULTIMATE")
    stubServerFiltering(rows)
    const { container } = render(<SqueezeBoardClient initialRows={initial} initialFetchedAt={FETCHED} />)
    fireEvent.click(within(group(container, "Tier")).getByText("ULTIMATE"))
    await waitFor(() => expect(container.textContent).toMatch(/Ultimate Guy/))
    expect(container.textContent).not.toMatch(/No editions match those filters/i)
  })

  it("filters by max effectively-buyable", async () => {
    const fn = stubServerFiltering(rows)
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    // ≤ 5 keeps Legend(4) + Ultimate(3), drops Common(500)
    fireEvent.click(within(group(container, "Max effectively buyable")).getByText("≤ 5"))
    await waitFor(() => expect(container.textContent).not.toMatch(/Common Guy/))
    expect(squeezeCalls(fn).at(-1)?.searchParams.get("max_buyable")).toBe("5")
    expect(container.textContent).toMatch(/Legend Guy/)
    expect(container.textContent).toMatch(/Ultimate Guy/)
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

  // 2026-10-03 (beta feedback 10250 / 10252): the top of the board is 1/1s and
  // Ultimates that are 100 % squeezed by arithmetic. Two FLOORS, sent to the
  // server like every other control.
  it("floors on total mint (MIN MINT) and on effectively buyable (MIN BUYABLE), each sent to the server", async () => {
    const fn = stubServerFiltering(rows)
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    // ≥ 100 keeps Common(15000), drops Legend(circ 99) + Ultimate(circ 8)
    fireEvent.click(within(group(container, "Min circulation")).getByText("≥ 100"))
    await waitFor(() => expect(container.textContent).not.toMatch(/Ultimate Guy/))
    expect(squeezeCalls(fn).at(-1)?.searchParams.get("min_circulation")).toBe("100")
    expect(container.textContent).toMatch(/Common Guy/)
    expect(container.textContent).not.toMatch(/Legend Guy/)
    // ≥ 250 buyable keeps only Common(500 buyable)
    fireEvent.click(within(group(container, "Min effectively buyable")).getByText("≥ 250"))
    await waitFor(() => expect(squeezeCalls(fn).at(-1)?.searchParams.get("min_buyable")).toBe("250"))
    expect(window.location.search).toContain("min_circulation=100")
    expect(window.location.search).toContain("min_buyable=250")
  })

  // 2026-10-03 (beta feedback 10253): a TEAM filter. The typed text goes to the
  // server, which resolves the FRANCHISE (historic labels included); the note
  // says what was matched, and a miss is an honest empty board, never the
  // unfiltered one.
  it("sends the typed team to the server, names the resolved franchise, and clears", async () => {
    const teamRows = rows.map((r, i) => ({ ...r, team_name: i === 0 ? "Los Angeles Clippers" : "Boston Celtics" }))
    const fn = stubServerFiltering(teamRows)
    const { container } = render(<SqueezeBoardClient initialRows={teamRows} initialFetchedAt={FETCHED} />)
    const box = within(group(container, "Team")).getByLabelText("Team name") as HTMLInputElement
    fireEvent.change(box, { target: { value: "clippers" } })
    fireEvent.submit(group(container, "Team"))
    await waitFor(() => expect(squeezeCalls(fn).at(-1)?.searchParams.get("team")).toBe("clippers"))
    await waitFor(() => expect(container.textContent).toMatch(/Team: LA Clippers — every label this franchise has minted under \(2 names, historic included\)/))
    expect(container.textContent).toMatch(new RegExp(teamRows[0].player_name as string))
    expect(container.textContent).not.toMatch(new RegExp(teamRows[1].player_name as string))
    expect(window.location.search).toContain("team=clippers")
    fireEvent.click(within(group(container, "Team")).getByText("Clear ✕"))
    await waitFor(() => expect(window.location.search).not.toContain("team="))
    expect(box.value).toBe("")
  })

  it("a team nothing matches reads as an honest empty board naming the query — not 'no editions match those filters'", async () => {
    stubServerFiltering(rows.map((r) => ({ ...r, team_name: "Boston Celtics" })))
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    fireEvent.change(within(group(container, "Team")).getByLabelText("Team name"), { target: { value: "zzzz" } })
    fireEvent.submit(group(container, "Team"))
    await waitFor(() => expect(container.textContent).toMatch(/No Top Shot team matches “zzzz”/))
    expect(container.textContent).not.toMatch(/No editions match those filters/)
  })

  it("filters by max circulation (trophy-scarce)", async () => {
    const fn = stubServerFiltering(rows)
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    // ≤ 10 (Ultimate) keeps only Ultimate(circ 8)
    fireEvent.click(within(group(container, "Max circulation")).getByText(/≤ 10 \(Ultimate\)/))
    await waitFor(() => expect(container.textContent).not.toMatch(/Legend Guy/))
    expect(squeezeCalls(fn).at(-1)?.searchParams.get("max_circulation")).toBe("10")
    expect(container.textContent).toMatch(/Ultimate Guy/)
    expect(container.textContent).not.toMatch(/Common Guy/)
  })
})

// The refetch useEffect is skipped on the default view (sort=squeeze, no drill-down),
// so the populated + client-filter passes never touched it. A sort change or a
// set/player drill-down is the only thing that hits the server round-trip, its loading
// swap, the error path, and the min_squeeze=50-vs-0 branch.
// 2026-10-03 (beta feedback 10256): holder concentration. A row without a
// complete owner census is UNKNOWN — an em-dash with a reason, never "0%".
describe("SqueezeBoardClient — Top 5 hold column", () => {
  it("prints the share with its holder count, an em-dash + reason without a census, and counts coverage from the rows in hand", () => {
    const r = [
      row({ edition_id: "k", external_id: "141:5", player_name: "Known Census Guy", top5_share_pct: 62.5, holders: 41 }),
      row({ edition_id: "n", external_id: "141:6", player_name: "No Census Guy", top5_share_pct: null, holders: null }),
    ]
    const { container } = render(<SqueezeBoardClient initialRows={r} initialFetchedAt={FETCHED} />)
    const cells = [...container.querySelectorAll('[data-testid="top5-share"]')]
    expect(cells).toHaveLength(2)
    expect(cells[0].textContent).toMatch(/63%/)
    expect(cells[0].querySelector("span")?.getAttribute("title")).toMatch(/41 holders/)
    expect(cells[1].textContent).toBe("—")
    expect(cells[1].querySelector(".rpc-sq-census-missing")?.getAttribute("title")).toMatch(/unknown, not zero/i)
    // the missing-census cell carries no percentage at all
    expect(cells[1].textContent).not.toMatch(/%/)
    expect(container.textContent).toMatch(/\(1 of 2 of the rows shown\)/)
  })

  it("offers the concentration sort and sends it to the server", async () => {
    const fn = stubSqueezeFetch({ rows: [row({ edition_id: "c", external_id: "141:9", player_name: "Concentrated Guy", top5_share_pct: 90 })] })
    const { container } = render(<SqueezeBoardClient initialRows={rows} initialFetchedAt={FETCHED} />)
    fireEvent.change(container.querySelector(".rpc-sq-select")!, { target: { value: "concentration" } })
    await waitFor(() => expect(container.textContent).toMatch(/Concentrated Guy/))
    expect(String(fn.mock.calls.find((c) => String(c[0]).includes("/api/public/insights/squeeze"))?.[0])).toMatch(/sort=concentration/)
  })
})

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
  it("shows the empty state when the SERVER returns no row for the filters", async () => {
    const one = [row({ edition_id: "only", player_name: "Only Common", tier: "COMMON" })]
    stubServerFiltering(one)
    const { container } = render(<SqueezeBoardClient initialRows={one} initialFetchedAt={FETCHED} />)
    fireEvent.click(within(group(container, "Tier")).getByText("LEGENDARY"))
    await waitFor(() => expect(container.textContent).toMatch(/No editions match those filters/i))
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
