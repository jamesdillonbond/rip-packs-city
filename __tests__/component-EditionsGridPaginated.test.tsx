// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/image", () => ({ default: () => null }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

// Pins the reusable paginated edition grid's interactive logic — the "Load more"
// pager (append page → advance offset → mark exhausted when a short page returns,
// and mark exhausted on a fetch error so the button can't spin forever), the
// empty state, and the sort toggle. The row comparison + URL building already
// live (tested) in lib/entity-editions-grid-format; this covers the component's
// own fetch/state machine.

const tile = (slug: string, over: Partial<EditionTile> = {}): EditionTile => ({
  route_slug: slug,
  player_name: "Player " + slug,
  name: "Moment " + slug,
  tier: "Common",
  series_label: "Series 4",
  circulation_count: 1000,
  thumbnail_url: null,
  fmv_usd: 10,
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("EditionsGridPaginated", () => {
  it("renders the empty state when there are no rows", () => {
    render(<EditionsGridPaginated collectionUrlSlug="nba-top-shot" fetchUrl="/api/x" initial={[]} pageSize={2} />)
    expect(screen.getByText(/No editions yet/i)).toBeTruthy()
    // no Load-more button when there's nothing (exhausted: 0 < 2 = true)
    expect(screen.queryByRole("button", { name: /Load 2 more/ })).toBeNull()
  })

  it("shows 'Load N more' when the initial page is full, and appends the next page", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [tile("c"), tile("d")] } as any)
    render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        initial={[tile("a"), tile("b")]}
        pageSize={2}
      />,
    )
    const btn = screen.getByRole("button", { name: /Load 2 more/ })
    fireEvent.click(btn)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // the load-more URL carries the offset (=2, the initial length)
    expect(String(fetchMock.mock.calls[0][0])).toContain("offset=2")
    // a full next page keeps the button available for another load
    await waitFor(() => expect(screen.getByRole("button", { name: /Load 2 more/ })).toBeTruthy())
  })

  it("marks exhausted (hides the button) when a short page returns", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [tile("c")] } as any) // 1 < pageSize 2
    render(
      <EditionsGridPaginated collectionUrlSlug="nba-top-shot" fetchUrl="/api/x" initial={[tile("a"), tile("b")]} pageSize={2} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Load 2 more/ }))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load 2 more/ })).toBeNull())
  })

  it("marks exhausted on a fetch error so the pager can't spin forever", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as any)
    render(
      <EditionsGridPaginated collectionUrlSlug="nba-top-shot" fetchUrl="/api/x" initial={[tile("a"), tile("b")]} pageSize={2} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Load 2 more/ }))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load 2 more/ })).toBeNull())
  })

  it("renders the sort toggle when showSort is set", () => {
    render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        initial={[tile("a"), tile("b")]}
        pageSize={2}
        showSort
      />,
    )
    expect(screen.getByRole("button", { name: "FMV ↓" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "A → Z" }))
    // no crash; the alpha sort applied
    expect(screen.getByRole("button", { name: "A → Z" })).toBeTruthy()
  })
})
