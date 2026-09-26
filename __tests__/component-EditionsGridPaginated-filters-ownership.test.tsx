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

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
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
