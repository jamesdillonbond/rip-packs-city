// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
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
})
