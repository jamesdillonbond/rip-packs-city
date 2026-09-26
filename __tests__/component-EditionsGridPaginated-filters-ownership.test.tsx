// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/image", () => ({ default: () => null }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

// Player-page Editions (2026-09-25): the filter bar and the per-tile
// "Owned: X  Locked: Y" line. The ownership line may carry a number ONLY when
// the wallet's counts were actually read — no wallet, a failed read, and a
// wallet with nothing indexed must all render NO number, never "Owned: 0".

const tile = (slug: string, over: Partial<EditionTile> = {}): EditionTile => ({
  route_slug: slug,
  player_name: "Damian Lillard",
  name: "Moment " + slug,
  tier: "COMMON",
  tier_rank: 9,
  series_label: "Series 4",
  series_num: 4,
  circulation_count: 1000,
  thumbnail_url: null,
  fmv_usd: 10,
  team_name: "Portland Trail Blazers",
  set_name: "Base Set",
  ...over,
})

const ROWS: EditionTile[] = [
  tile("1:1", { tier: "LEGENDARY", tier_rank: 3, team_name: "Milwaukee Bucks" }),
  tile("1:2"),
  tile("1:2::17", { subedition_name: "Hexwave" }),
]

const WALLET = "0x1234567890abcdef"

// `fetchMock` answers the wallet counts route; `badgeMock` the batch badge
// route (which fires on mount whenever filters are shown). Routed by URL so
// the two reads never depend on call order.
type FetchFn = (url: string, init?: RequestInit) => Promise<any>
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>
let badgeMock: ReturnType<typeof vi.fn<FetchFn>>
const BADGES: Record<string, string[]> = { "1:1": ["Top Shot Debut", "Rookie Year"], "1:2": [], "1:2::17": ["Rookie Year"] }
beforeEach(() => {
  fetchMock = vi.fn<FetchFn>()
  badgeMock = vi.fn<FetchFn>(async () => ({ ok: true, json: async () => ({ badges: BADGES }) }))
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
    String(url).includes("/api/entity/edition-badges") ? badgeMock(url, init) : fetchMock(url, init))
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

// Tiles render the PLAYER as their subject, so identify them by their edition link.
const shown = () =>
  Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/edition/']")).map((a) => decodeURIComponent(a.getAttribute("href")!.split("/edition/")[1]))

function renderGrid(over: Partial<React.ComponentProps<typeof EditionsGridPaginated>> = {}) {
  return render(
    <EditionsGridPaginated
      collectionUrlSlug="nba-top-shot"
      fetchUrl="/api/x"
      initial={ROWS}
      pageSize={10}
      showFilters
      showOwnership
      {...over}
    />,
  )
}

describe("EditionsGridPaginated — ownership line", () => {
  it("renders no ownership line and makes no request when no wallet is loaded", () => {
    renderGrid()
    expect(screen.queryAllByTestId("tile-ownership")).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows Owned/Locked on every tile once counts load — an unlisted edition is a KNOWN zero", async () => {
    localStorage.setItem("rpc_owner_key", WALLET)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ editions: { "1:2": { owned: 3, locked: 1 } } }) } as any)
    renderGrid()
    await waitFor(() => expect(screen.getAllByTestId("tile-ownership")).toHaveLength(3))
    expect(String(fetchMock.mock.calls[0][0])).toContain(`wallet=${WALLET}`)
    const lines = screen.getAllByTestId("tile-ownership").map((n) => n.textContent)
    expect(lines).toContain("Owned: 3Locked: 1")
    expect(lines.filter((t) => t === "Owned: 0Locked: 0")).toHaveLength(2)
  })

  it("a FAILED counts read puts no number on any tile and says so", async () => {
    localStorage.setItem("rpc_owner_key", WALLET)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as any)
    renderGrid()
    await screen.findByText(/Couldn.t load your owned/)
    expect(screen.queryAllByTestId("tile-ownership")).toHaveLength(0)
    expect(screen.queryByText(/Owned: 0/)).toBeNull()
  })

  it("a wallet with NOTHING indexed is unknown, not 'Owned: 0' everywhere", async () => {
    localStorage.setItem("rpc_owner_key", WALLET)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ editions: {} }) } as any)
    renderGrid()
    await screen.findByText(/appears once your loaded wallet is indexed/)
    expect(screen.queryAllByTestId("tile-ownership")).toHaveLength(0)
  })

  it("never renders ownership on Pinnacle (its route_slug is not a wallet edition_key)", () => {
    localStorage.setItem("rpc_owner_key", WALLET)
    renderGrid({ collectionUrlSlug: "disney-pinnacle" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryAllByTestId("tile-ownership")).toHaveLength(0)
  })
})

describe("EditionsGridPaginated — filters", () => {
  it("narrows by rarity and reports the count against LOADED rows", () => {
    renderGrid()
    fireEvent.change(screen.getByLabelText("All Rarities"), { target: { value: "LEGENDARY" } })
    expect(screen.getByTestId("edition-filter-count").textContent).toBe("1 of 3 loaded editions")
    expect(shown()).toEqual(["1:1"])
  })

  it("filters Standard vs a named parallel", () => {
    renderGrid()
    fireEvent.change(screen.getByLabelText("All Parallels"), { target: { value: "Hexwave" } })
    expect(screen.getByTestId("edition-filter-count").textContent).toBe("1 of 3 loaded editions")
    expect(shown()).toEqual(["1:2::17"])
  })

  it("an empty match while more pages remain says so rather than concluding", () => {
    renderGrid({ pageSize: 3 })
    fireEvent.change(screen.getByLabelText("Filter editions"), { target: { value: "zzz-no-match" } })
    expect(screen.getByTestId("edition-filter-count").textContent).toContain("more not loaded yet")
    expect(screen.getByText(/Nothing among the loaded editions matches these filters — load more/)).toBeTruthy()
  })

  it("offers the Ownership filter only once the wallet's counts are known", async () => {
    renderGrid()
    expect(screen.queryByLabelText("Ownership")).toBeNull()
    cleanup()
    localStorage.setItem("rpc_owner_key", WALLET)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ editions: { "1:2": { owned: 2, locked: 2 } } }) } as any)
    renderGrid()
    const sel = await screen.findByLabelText("Ownership")
    fireEvent.change(sel, { target: { value: "locked" } })
    expect(screen.getByTestId("edition-filter-count").textContent).toBe("1 of 3 loaded editions")
    expect(shown()).toEqual(["1:2"])
  })

  it("Clear filters restores the full grid", () => {
    renderGrid()
    fireEvent.change(screen.getByLabelText("All Teams"), { target: { value: "Milwaukee Bucks" } })
    fireEvent.click(screen.getByText("Clear filters"))
    expect(screen.queryByTestId("edition-filter-count")).toBeNull()
    expect(shown()).toHaveLength(3)
  })
})

describe("EditionsGridPaginated — badge filter", () => {
  it("requests badges for the loaded slugs and offers them rookie-first", async () => {
    renderGrid()
    const sel = (await screen.findByLabelText("All Badges")) as HTMLSelectElement
    // A GET (proxy.ts opens /api/entity/* to signed-out readers for GET only).
    expect(badgeMock.mock.calls[0][1]?.method ?? "GET").toBe("GET")
    const u = new URL(String(badgeMock.mock.calls[0][0]), "https://t")
    expect(u.searchParams.get("collection")).toBe("nba-top-shot")
    expect(u.searchParams.get("slugs")!.split(",")).toEqual(["1:1", "1:2", "1:2::17"])
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["all", "Rookie Year", "Top Shot Debut"])
  })

  it("narrows to editions carrying the badge", async () => {
    renderGrid()
    fireEvent.change(await screen.findByLabelText("All Badges"), { target: { value: "Rookie Year" } })
    expect(shown()).toEqual(["1:1", "1:2::17"])
  })

  it("a FAILED badge read offers no Badge filter and says the badges are unknown — never 'no badges'", async () => {
    badgeMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    renderGrid()
    await screen.findByText(/Couldn.t load badges for 3 editions/)
    expect(screen.queryByLabelText("All Badges")).toBeNull()
  })

  it("Retry re-reads the failed badges and the failure line clears only once THEY load (reviewed 2026-09-25)", async () => {
    let fail = true
    badgeMock.mockImplementation(async () =>
      fail ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => ({ badges: BADGES }) })
    renderGrid()
    await screen.findByText(/Couldn.t load badges for 3 editions/)
    expect(badgeMock).toHaveBeenCalledTimes(1)
    fail = false
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(badgeMock).toHaveBeenCalledTimes(2))
    const u = new URL(String(badgeMock.mock.calls[1][0]), "https://t")
    expect(u.searchParams.get("slugs")!.split(",")).toEqual(["1:1", "1:2", "1:2::17"])
    await waitFor(() => expect(screen.queryByText(/Couldn.t load badges/)).toBeNull())
    expect(await screen.findByLabelText("All Badges")).toBeTruthy()
  })

  it("an Ownership choice does not stay active behind a hidden select once ownership becomes unknown", async () => {
    localStorage.setItem("rpc_owner_key", WALLET)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ editions: { "1:2": { owned: 3, locked: 1 } } }) } as any)
    renderGrid()
    const own = await screen.findByLabelText(/ownership/i)
    fireEvent.change(own, { target: { value: "owned" } })
    expect(shown()).toEqual(["1:2"])
    // The counts read now fails (e.g. the wallet changed and its read errored).
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as any)
    localStorage.setItem("rpc_owner_key", "0xabcdefabcdef1234")
    window.dispatchEvent(new StorageEvent("storage", { key: "rpc_owner_key" }))
    await waitFor(() => expect(screen.queryByLabelText(/ownership/i)).toBeNull())
    expect(shown()).toEqual(["1:1", "1:2", "1:2::17"])
    expect(screen.queryByText(/Clear filters/)).toBeNull()
  })

  it("an edition the badge read does not return is unknown: it cannot match, and the grid counts it", async () => {
    badgeMock.mockImplementation(async () => ({ ok: true, json: async () => ({ badges: { "1:1": ["Rookie Year"] } }) }))
    renderGrid()
    fireEvent.change(await screen.findByLabelText("All Badges"), { target: { value: "Rookie Year" } })
    expect(shown()).toEqual(["1:1"])
    expect(screen.getByText(/Badges not known for 2 loaded editions/)).toBeTruthy()
  })

  it("never requests badges on Pinnacle", () => {
    renderGrid({ collectionUrlSlug: "disney-pinnacle" })
    expect(badgeMock).not.toHaveBeenCalled()
  })
})
