// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, within } from "@testing-library/react"

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
})

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
