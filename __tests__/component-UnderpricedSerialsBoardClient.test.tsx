// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react"
import React from "react"
import type { UnderpricedRow } from "@/lib/underpriced-serials-board"

// Underpriced special-serials board client — had NO dedicated test (61.4% br).
// Drives the initial ranked render (tight vs coarse estimate rows), the
// headline / tier / quality filter pills + sort dropdown (which refetch with
// the right params), and the error state.

import UnderpricedSerialsBoardClient from "@/app/insights/underpriced-serials/UnderpricedSerialsBoardClient"

const row = (o: Partial<UnderpricedRow> = {}): UnderpricedRow => ({
  edition_id: "ed-1", external_id: "3:45", edition_key: "3:45", player_name: "Damian Lillard",
  set_name: "Base Set", tier: "LEGENDARY", circulation_count: 499, thumbnail_url: null, nft_id: "111",
  serial_number: 1, kind: "first", ask_usd: 80, serial_fmv_usd: 200, edition_fmv_usd: 150,
  confidence: "HIGH", discount_pct: 60, discount_usd: 120, estimate_quality: "tight",
  listing_url: "https://x", listed_at: "2026-08-01T00:00:00Z", last_seen_at: "2026-08-02T00:00:00Z", ...o,
})

const initialRows: UnderpricedRow[] = [
  row(),
  row({ edition_id: "ed-2", player_name: "Scoot", kind: "perfect", serial_number: 12000, circulation_count: 12000, estimate_quality: "coarse", discount_pct: 33, ask_usd: 4, serial_fmv_usd: 6 }),
]

let fetchFn: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchFn = vi.fn(async (url: string) => {
    if (String(url).includes("/api/profile/me")) return { ok: true, status: 200, json: async () => ({ user: null }) }
    return {
      ok: true, status: 200,
      json: async () => ({ meta: { fetched_at: "2026-08-02T00:00:00Z", total_rows: 1, elapsed_ms: 5 }, rows: [row({ player_name: "Refetched Player" })] }),
    }
  })
  vi.stubGlobal("fetch", fetchFn)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("UnderpricedSerialsBoardClient", () => {
  it("renders the initial ranked rows including tight vs coarse estimates", () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt="2026-08-01T00:00:00Z" />)
    expect(container.textContent).toContain("Damian Lillard")
    expect(container.textContent).toContain("Scoot")
    // coarse estimate row prefixes the discount with ~
    expect(container.textContent).toMatch(/~33%/)
    // no refetch at the default filter set
    expect(fetchFn.mock.calls.every((c) => !String(c[0]).includes("underpriced-serials?"))).toBe(true)
  })

  it("refetches with the headline param when a headline pill is clicked", async () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt={null} />)
    // The #1-only headline pill.
    const pill = [...container.querySelectorAll("button")].find((b) => /#1|first mint|mint #1/i.test(b.textContent ?? ""))
    expect(pill).toBeTruthy()
    fireEvent.click(pill!)
    await waitFor(() => expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("underpriced-serials?"))).toBe(true))
    const call = fetchFn.mock.calls.find((c) => String(c[0]).includes("underpriced-serials?"))!
    expect(String(call[0])).toMatch(/headline=no1/)
    await waitFor(() => expect(container.textContent).toContain("Refetched Player"))
  })

  it("refetches with the sort param when the sort dropdown changes", async () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt={null} />)
    const select = container.querySelector("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "ask" } })
    await waitFor(() => expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("sort=ask"))).toBe(true))
  })

  it("shows the error state when a refetch fails", async () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt={null} />)
    fetchFn.mockImplementation(async (url: string) =>
      String(url).includes("/api/profile/me")
        ? { ok: true, status: 200, json: async () => ({ user: null }) }
        : { ok: false, status: 500, json: async () => ({}) },
    )
    const select = container.querySelector("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "recent" } })
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load|HTTP 500/i))
  })

  it("refetches with the tier param when a tier pill is clicked", async () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt={null} />)
    const pill = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Legendary")!
    expect(pill).toBeTruthy()
    fireEvent.click(pill)
    await waitFor(() =>
      expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("tier=LEGENDARY"))).toBe(true),
    )
  })

  it("refetches with quality=tight when the Tight-only pill is clicked", async () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt={null} />)
    const pill = [...container.querySelectorAll("button")].find((b) => /tight only/i.test(b.textContent ?? ""))!
    fireEvent.click(pill)
    await waitFor(() =>
      expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("quality=tight"))).toBe(true),
    )
  })

  it("renders the empty state when there are no underpriced serials", () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={[]} initialFetchedAt={null} />)
    expect(container.textContent).toMatch(/No underpriced headline serials right now/i)
  })

  it("BoardImage falls back to thumbnail_url on error, then to the gradient placeholder", () => {
    const withThumb = row({ nft_id: "999", thumbnail_url: "https://thumb.example/x.png", estimate_quality: "tight" })
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={[withThumb]} initialFetchedAt={null} />)
    const img = container.querySelector("img") as HTMLImageElement
    // primary src is the per-moment media CDN
    expect(img.getAttribute("src")).toContain("assets.nbatopshot.com/media/999")
    // first error -> swap to thumbnail_url
    fireEvent.error(img)
    const img2 = container.querySelector("img") as HTMLImageElement
    expect(img2.getAttribute("src")).toBe("https://thumb.example/x.png")
    // second error -> no more fallbacks -> the gradient placeholder div replaces it
    fireEvent.error(img2)
    expect(container.querySelector(".rpc-us-img-fallback")).toBeTruthy()
  })

  it("falls back to the /edition/ href and the gradient tile when there is no nft_id", () => {
    const noNft = row({ nft_id: null, thumbnail_url: null, external_id: "7:88", estimate_quality: "coarse", discount_pct: 25 })
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={[noNft]} initialFetchedAt={null} />)
    // momentHref uses external_id when nft_id is absent
    expect(container.querySelector('a[href*="/nba-top-shot/edition/"]')).toBeTruthy()
    // no nft_id + no thumbnail -> BoardImage renders the gradient fallback
    expect(container.querySelector(".rpc-us-img-fallback")).toBeTruthy()
    // heroRows fallback pool (no tight rows -> uses discounted coarse rows)
    expect(container.querySelector(".rpc-us-hero-strip")).toBeTruthy()
  })

  it("stops propagation when the row Buy link is clicked", () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt={null} />)
    const buy = [...container.querySelectorAll("a.rpc-us-buy")][0] as HTMLAnchorElement
    expect(buy).toBeTruthy()
    // clicking the buy link must not throw; its onClick calls e.stopPropagation()
    fireEvent.click(buy)
    expect(within(container).getAllByText(/Damian Lillard/).length).toBeGreaterThan(0)
  })

  it("appends ?ref= to the copy URL for a signed-in sharer and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    fetchFn.mockImplementation(async (url: string) =>
      String(url).includes("/api/profile/me")
        ? { ok: true, status: 200, json: async () => ({ user: { id: "user-42" } }) }
        : { ok: true, status: 200, json: async () => ({ meta: { fetched_at: null }, rows: [] }) },
    )
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={initialRows} initialFetchedAt={null} />)
    // wait for /api/profile/me to resolve and set myUserId
    await waitFor(() => expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/api/profile/me"))).toBe(true))
    const copyBtn = [...container.querySelectorAll("button")].find((b) => /copy link/i.test(b.textContent ?? ""))!
    fireEvent.click(copyBtn)
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(String(writeText.mock.calls[0][0])).toContain("ref=user-42")
    await waitFor(() => expect(container.textContent).toMatch(/Copied!/i))
  })
})
