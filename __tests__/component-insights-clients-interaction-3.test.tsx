// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// Third interaction/branch pass over low-branch public /insights board clients
// (continues the -2 file). TrophiesBoardClient (47.7% br) + UnderpricedSerials
// BoardClient (51.7% br): the collection/type/headline/tier/quality/sort filter
// toggles that REFETCH (asserted on request params), the discount/coarse ("~%")
// formatter branch, the per-row image fallback, and the error state — all dark
// above the smoke/populated baseline.
// ─────────────────────────────────────────────────────────────────────────────

import TrophiesBoardClient, { type Row as TrophyRow } from "@/app/insights/trophies/TrophiesBoardClient"
import UnderpricedSerialsBoardClient from "@/app/insights/underpriced-serials/UnderpricedSerialsBoardClient"
import type { UnderpricedRow } from "@/lib/underpriced-serials-board"

const FETCHED = "2026-08-08T00:00:00Z"
let boardResponse: { ok: boolean; rows?: unknown[]; status?: number }

beforeEach(() => {
  boardResponse = { ok: true, rows: [] }
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) {
        return Promise.resolve({ ok: true, json: async () => ({ user: null }) } as Response)
      }
      if (!boardResponse.ok) return Promise.resolve({ ok: false, status: boardResponse.status ?? 500 } as Response)
      return Promise.resolve({
        ok: true,
        json: async () => ({ rows: boardResponse.rows ?? [], meta: { fetched_at: FETCHED } }),
      } as Response)
    })
  )
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ── Trophies ────────────────────────────────────────────────────────────────
function trophyRow(o: Partial<TrophyRow>): TrophyRow {
  return {
    edition_id: "e1", external_id: "10:20", collection: "nba_top_shot", collection_id: "c1",
    name: "Grail", player_name: "Star Player", set_name: "Base", team_name: "Team", tier: "LEGENDARY",
    series: 4, circulation_count: 1, thumbnail_url: "https://cdn/t.png", video_url: null,
    is_one_of_one: true, is_ultimate: false, fmv_usd: 9000, confidence: "HIGH", fmv_computed_at: FETCHED, ...o,
  }
}
const trophyRows: TrophyRow[] = [
  trophyRow({ player_name: "One Of One", is_one_of_one: true, fmv_usd: 9000, circulation_count: 1 }),
  trophyRow({ edition_id: "e2", player_name: "Ultimate Guy", is_one_of_one: false, is_ultimate: true, fmv_usd: 3000, circulation_count: 25 }),
]

describe("TrophiesBoardClient — filter refetch + error", () => {
  it("renders trophy tiles", () => {
    const { container } = render(<TrophiesBoardClient initialRows={trophyRows} initialFetchedAt={FETCHED} />)
    expect((container.textContent ?? "")).toContain("One Of One")
  })
  it("refetches with collection= when the Top Shot pill is clicked", async () => {
    const { getByText } = render(<TrophiesBoardClient initialRows={trophyRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: trophyRows }
    fireEvent.click(getByText("Top Shot"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("collection=nba_top_shot"))).toBe(true)
    })
  })
  it("refetches with type= when the 1-of-1 pill is clicked", async () => {
    const { getByText } = render(<TrophiesBoardClient initialRows={trophyRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: trophyRows }
    fireEvent.click(getByText("1 of 1"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("type=one_of_one"))).toBe(true)
    })
  })
  it("refetches when the sort select changes", async () => {
    const { container } = render(<TrophiesBoardClient initialRows={trophyRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: trophyRows }
    fireEvent.change(container.querySelector("select") as HTMLSelectElement, { target: { value: "circulation" } })
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("sort=circulation"))).toBe(true)
    })
  })
  it("shows the error state on a non-ok refetch", async () => {
    const { getByText, container } = render(<TrophiesBoardClient initialRows={trophyRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: false, status: 500 }
    fireEvent.click(getByText("Ultimate"))
    await waitFor(() => expect((container.textContent ?? "")).toContain("Failed to load"))
  })
})

// ── UnderpricedSerials ──────────────────────────────────────────────────────
function upRow(o: Partial<UnderpricedRow>): UnderpricedRow {
  return {
    edition_id: "e1", external_id: "10:20", edition_key: "10:20", player_name: "Deal Player", set_name: "Base",
    tier: "RARE", circulation_count: 199, thumbnail_url: "https://cdn/u.png", nft_id: "500", serial_number: 1,
    kind: "first", ask_usd: 40, serial_fmv_usd: 100, edition_fmv_usd: 55, confidence: "HIGH",
    discount_pct: 60, discount_usd: 60, estimate_quality: "tight", listing_url: "https://flowty/x", listed_at: FETCHED, last_seen_at: FETCHED, ...o,
  }
}
const upRows: UnderpricedRow[] = [
  upRow({ player_name: "Tight Deal", estimate_quality: "tight", discount_pct: 60 }),
  upRow({ edition_id: "e2", player_name: "Coarse Deal", estimate_quality: "coarse", discount_pct: 45, kind: "perfect", serial_number: 199 }),
]

describe("UnderpricedSerialsBoardClient — filter refetch + formatter branches", () => {
  it("renders rows incl. the coarse '~%' discount branch", () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={upRows} initialFetchedAt={FETCHED} />)
    const text = container.textContent ?? ""
    expect(text).toContain("Tight Deal")
    expect(text).toContain("~45%") // coarse estimate → ~ prefix
    expect(text).toContain("60%") // tight
  })
  it("refetches with headline= when the #1 Mint pill is clicked", async () => {
    const { getByText } = render(<UnderpricedSerialsBoardClient initialRows={upRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: upRows }
    fireEvent.click(getByText("#1 Mint"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("headline=no1"))).toBe(true)
    })
  })
  it("refetches with quality=tight on the Tight only pill", async () => {
    const { getByRole } = render(<UnderpricedSerialsBoardClient initialRows={upRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: upRows }
    fireEvent.click(getByRole("tab", { name: "Tight only" }))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("quality=tight"))).toBe(true)
    })
  })
  it("refetches when the sort select changes", async () => {
    const { container } = render(<UnderpricedSerialsBoardClient initialRows={upRows} initialFetchedAt={FETCHED} />)
    boardResponse = { ok: true, rows: upRows }
    fireEvent.change(container.querySelector("select") as HTMLSelectElement, { target: { value: "ask" } })
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("sort=ask"))).toBe(true)
    })
  })
})
