// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// REGRESSION (2026-08-02): /insights/serial-premiums?headline=perfect rendered
// the #1-Mint board. The API route read `headline`, and the in-page toggle
// worked, but the client never looked at the URL — so every shared or
// bookmarked "Perfect Mint" link landed on the wrong board (wrong h1, wrong
// featured row).
//
// The page is statically rendered with headline "no1" in the server HTML, so
// the param is applied in a mount EFFECT (a useState initializer would be a
// hydration mismatch). Two things must therefore hold: the effect flips the
// mode, AND it triggers exactly ONE refetch — the fetch effect's isFirstRun
// guard is consumed by the default-matching first pass.
//
// Also pins the shadowing trap: `window` is shadowed inside the component by
// the WindowFilter state, so the lookup must go through globalThis.

import SerialPremiumsBoardClient from "@/app/insights/serial-premiums/SerialPremiumsBoardClient"
import type { SerialBoardRow } from "@/lib/serial-premiums-board"

const row = (over: Partial<SerialBoardRow> = {}): SerialBoardRow => ({
  edition_id: "e1",
  external_id: "141:5156",
  player_name: "Nikola Jokic",
  set_name: "Base Set",
  tier: "LEGENDARY",
  circulation_count: 3000,
  thumbnail_url: null,
  moment_id: null,
  nft_id: "999",
  edition_median_usd: 10,
  premium_multiple: 1125,
  edition_sales_180d: 40,
  is_conflated: false,
  headline_serial: 1,
  headline_last_sale_usd: 11250,
  headline_sold_at: new Date().toISOString(),
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>

function setUrl(search: string) {
  globalThis.history.replaceState({}, "", `/insights/serial-premiums${search}`)
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes("/api/profile/me")) {
      return { ok: true, json: async () => ({ user: null }) } as unknown as Response
    }
    return {
      ok: true,
      json: async () => ({
        meta: { fetched_at: new Date().toISOString(), total_rows: 1, elapsed_ms: 1 },
        rows: [row({ player_name: "Perfect Guy", headline_serial: 3000 })],
      }),
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setUrl("")
})

const boardCalls = () =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/public/insights/serial-premiums"))

describe("SerialPremiumsBoardClient — ?headline URL param", () => {
  it("renders the #1-mint board and does NOT refetch with no param", async () => {
    setUrl("")
    const { container } = render(
      <SerialPremiumsBoardClient initialRows={[row()]} initialFetchedAt={null} />
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector("h1")?.textContent ?? "").toContain("#1")
    expect(boardCalls()).toHaveLength(0)
  })

  it("honours ?headline=perfect: switches the board and fetches it exactly once", async () => {
    setUrl("?headline=perfect")
    const { container } = render(
      <SerialPremiumsBoardClient initialRows={[row()]} initialFetchedAt={null} />
    )
    await waitFor(() => expect(boardCalls()).toHaveLength(1))
    expect(String(boardCalls()[0][0])).toContain("headline=perfect")
    await waitFor(() =>
      expect(container.querySelector("h1")?.textContent ?? "").toContain("perfect")
    )
    // one and only one board fetch — the isFirstRun guard must not double-fire
    expect(boardCalls()).toHaveLength(1)
  })

  it("ignores an unknown ?headline value and stays on the default board", async () => {
    setUrl("?headline=bogus")
    const { container } = render(
      <SerialPremiumsBoardClient initialRows={[row()]} initialFetchedAt={null} />
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.querySelector("h1")?.textContent ?? "").toContain("#1")
    expect(boardCalls()).toHaveLength(0)
  })
})
