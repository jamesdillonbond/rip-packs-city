// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/image", () => ({ default: () => null }))
vi.mock("@/lib/ipfs-media", () => ({ proxyIpfsUrl: (u: string) => u }))

import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

// Pins the reusable paginated edition grid's interactive logic — the "Load more"
// pager (append page → advance offset → mark exhausted when a short page returns,
// and — deliberately NOT exhausted on a fetch error, because a failed page is not
// the end of the list), the empty state, and the sort toggle. The row comparison + URL building already
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

  // ⚠⚠ THIS TEST WAS STALE AND PROVABLY BLIND (rewritten 2026-08-26). Its title
  // said "marks exhausted on a fetch error" — which is the OPPOSITE of what this
  // component does: the `catch` was deliberately changed to `setLoadFailed(true)`
  // so a failed page cannot masquerade as the end of the list, and the source
  // carries a comment saying so.
  //
  // It kept passing only because the button's LABEL changes to "Retry" on
  // failure, so `queryByRole("button", { name: /Load 2 more/ })` is null under
  // BOTH the fix and the defect. Demonstrated, not assumed: re-introducing
  // `setExhausted(true)` in the catch left this file at 11/11 green.
  //
  // ⭐ Asserting that an affordance DISAPPEARED is almost always the wrong
  // assertion. Assert what the reader can now see and do.
  it("does NOT present a truncated list as complete when Load more errors", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as any)
    render(
      <EditionsGridPaginated collectionUrlSlug="nba-top-shot" fetchUrl="/api/x" initial={[tile("a"), tile("b")]} pageSize={2} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Load 2 more/ }))
    // The incompleteness is disclosed, and the way forward survives.
    await waitFor(() => expect(screen.getByText(/isn.t the end of the list/i)).toBeTruthy())
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy()
  })

  it("NO-CHANGE CONTROL — a genuinely short page still exhausts and offers nothing more", async () => {
    // Guards the opposite failure: never exhausting would satisfy the test above
    // while leaving a pager on a list that has really ended.
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [tile("c")] } as any)
    render(
      <EditionsGridPaginated collectionUrlSlug="nba-top-shot" fetchUrl="/api/x" initial={[tile("a"), tile("b")]} pageSize={2} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Load 2 more/ }))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load 2 more/ })).toBeNull())
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull()
    expect(screen.queryByText(/isn.t the end of the list/i)).toBeNull()
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

  it("renders a rich tile's footer branches (set link, series label, Mint count, Hit%/Wt) and a video on hover", () => {
    // matchMedia present + not reduced -> usePrefersReducedMotion returns false,
    // so a videoUrl-bearing Top Shot tile can hover-mount its clip.
    const mq = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    ;(window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => mq

    const { container } = render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        initial={[
          tile("rich", {
            set_name: "Base Set",
            series_label: "Series 4",
            circulation_count: 2500,
            thumbnail_url: "https://assets.nbatopshot.com/editions/xyz/",
            rep_nft_id: "9001",
            video_url: "https://clip/x.mp4",
            hit_probability: 0.0125,
            drop_weight: 40,
          }),
        ]}
        pageSize={5}
      />,
    )
    expect(container.textContent).toContain("Base Set")   // showSetLink && set_name
    expect(container.textContent).toContain("Series 4")   // series_label
    expect(container.textContent).toContain("Mint")       // circulation present
    expect(container.textContent).toContain("Hit 1.25%")  // hit_probability branch
    expect(container.textContent).toContain("Wt")         // drop_weight branch

    const media = container.querySelector("img")?.parentElement as HTMLElement
    fireEvent.mouseEnter(media)
    expect(container.querySelector("video")).toBeTruthy() // canVideo && hover -> video mounts
    fireEvent.mouseLeave(media)

    delete (window as unknown as { matchMedia?: unknown }).matchMedia
  })

  it("renders the 'Mint —' fallback for a null circulation and no set/series labels", () => {
    const { container } = render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        initial={[
          tile("bare", { circulation_count: null, set_name: null, series_label: null }),
        ]}
        pageSize={5}
      />,
    )
    expect(container.textContent).toContain("Mint —") // circulation null branch
  })

  it("advances the image candidate on load error, then shows 'No image' when candidates run out", () => {
    const { container } = render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        // TS tile with rep_nft_id + thumbnail -> two image candidates.
        initial={[
          tile("img", { rep_nft_id: "12345", thumbnail_url: "https://ipfs.io/ipfs/QmABC" }),
        ]}
        pageSize={5}
      />,
    )
    let img = container.querySelector("img")!
    const first = img.getAttribute("src")
    fireEvent.error(img) // onError -> imgIdx++ -> second candidate
    img = container.querySelector("img")!
    expect(img.getAttribute("src")).not.toBe(first)
    fireEvent.error(img) // exhaust candidates
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("No image")
  })

  it("does not arm hover-video for reduced-motion users", () => {
    const mq = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    ;(window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => mq
    const { container } = render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        initial={[tile("rm", { thumbnail_url: "https://cdn/x.png", video_url: "https://clip/x.mp4" })]}
        pageSize={5}
      />,
    )
    const media = container.querySelector("img")?.parentElement as HTMLElement
    fireEvent.mouseEnter(media)
    expect(container.querySelector("video")).toBeNull() // reduced -> canVideo false
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
  })

  it("packMode: pulls drop_weight=0 rows into a collapsible 'exhausted' section that toggles open", () => {
    const { container, getByText, queryByText } = render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        initial={[
          tile("live", { drop_weight: 10 }),
          tile("dead1", { drop_weight: 0 }),
          tile("dead2", { drop_weight: 0 }),
        ]}
        pageSize={5}
        packMode
      />,
    )
    // Header shows the exhausted count (2 pulled out).
    const toggle = getByText(/Exhausted \/ pulled out \(2\)/)
    expect(toggle).toBeTruthy()
    // Collapsed by default -> the exhausted grid isn't shown yet.
    expect(container.querySelectorAll("a").length).toBe(1) // only the live grid row
    fireEvent.click(toggle)
    // Expanded -> the two exhausted tiles render.
    expect(container.querySelectorAll("a").length).toBe(3)
    expect(queryByText(/Load more above/)).toBeNull()
  })

  it("packMode: shows the 'Load more above' placeholder when the exhausted total isn't loaded yet", () => {
    const { getByText } = render(
      <EditionsGridPaginated
        collectionUrlSlug="nba-top-shot"
        fetchUrl="/api/x"
        // No drop_weight=0 rows loaded, but the server says 4 exist.
        initial={[tile("live1", { drop_weight: 5 }), tile("live2", { drop_weight: 5 })]}
        pageSize={2}
        packMode
        exhaustedTotal={4}
      />,
    )
    fireEvent.click(getByText(/Exhausted \/ pulled out \(4\)/))
    expect(getByText(/Load more above to reveal the exhausted editions/)).toBeTruthy()
  })
})
