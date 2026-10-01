// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// /admin/click-purchases. Pins the honesty rules in the client header: the page
// says what each confidence means ("presumed"), says when the list was capped,
// shows bots apart from humans, and an empty window says "no matching sale"
// rather than rendering an empty table.

const resource: any = {}
vi.mock("@/lib/admin/use-admin-resource", () => ({ useAdminResource: () => resource }))

import ClickPurchasesClient, { bySurface, fmtUsd, type ClickPurchasesPayload } from "@/app/admin/click-purchases/ClickPurchasesClient"

const payload: ClickPurchasesPayload = {
  generated_at: "2026-10-01T04:00:00Z",
  days: 30,
  since_day_pt: "2026-08-31",
  totals: { clicks: 9, clicks_human: 7, clicks_internal: 1, purchases_confirmed: 1, purchases_likely: 1, purchases_possible: 0, sales_confirmed_or_likely: 1, usd_confirmed_or_likely: 0.25 },
  purchases_truncated: false,
  funnel: [
    { day_pt: "2026-09-30", source: "alert", surface: "alert", collection_slug: "nba_top_shot", clicks: 5, clicks_human: 4, clicks_internal: 1, purchases_confirmed: 1, purchases_likely: 0, purchases_possible: 0, sales_confirmed_or_likely: 1, usd_confirmed_or_likely: 0.25 },
    { day_pt: "2026-09-29", source: "alert", surface: "alert", collection_slug: "nba_top_shot", clicks: 2, clicks_human: 1, clicks_internal: 0, purchases_confirmed: 0, purchases_likely: 1, purchases_possible: 0, sales_confirmed_or_likely: 0, usd_confirmed_or_likely: 0 },
    { day_pt: "2026-09-29", source: "site", surface: "sniper", collection_slug: "nba_top_shot", clicks: 2, clicks_human: 2, clicks_internal: 0, purchases_confirmed: 0, purchases_likely: 0, purchases_possible: 0, sales_confirmed_or_likely: 0, usd_confirmed_or_likely: 0 },
  ],
  purchases: [
    { click_id: 1, clicked_at: "2026-10-01T03:00:00Z", collection_slug: "nba_top_shot", sale_source: "sales", sale_ref: "s1", nft_id: "16818", sold_at: "2026-10-01T03:04:00Z", price_usd: 0.25, match: "same_moment", confidence: "confirmed", buyer_is_clicker: true, minutes_after_click: 4, surface: "alert", source: "alert", channel: "telegram", player_name: "Greg Brown III", set_name: "Hustle and Show", ask_price_usd: 0.25 },
  ],
}

afterEach(() => cleanup())
beforeEach(() => {
  Object.assign(resource, {
    token: "tok", tokenInput: "", setTokenInput: vi.fn(), submitToken: vi.fn(),
    data: payload, loading: false, error: null, stale: false, refresh: vi.fn(),
  })
})

describe("ClickPurchasesClient", () => {
  it("helpers: bySurface merges days per source × surface; fmtUsd never fabricates", () => {
    expect(bySurface(payload.funnel)).toEqual([
      { source: "alert", surface: "alert", clicks_human: 5, confirmed: 1, likely: 1, possible: 0 },
      { source: "site", surface: "sniper", clicks_human: 2, confirmed: 0, likely: 0, possible: 0 },
    ])
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(0.25)).toBe("$0.25")
  })

  it("renders totals, the presumed-purchase definitions, and the purchase row", () => {
    render(<ClickPurchasesClient />)
    expect(screen.getByText(/the buyer was the/)).toBeTruthy()
    expect(screen.getByText(/bots 2/)).toBeTruthy()
    expect(screen.getByText(/Greg Brown III · Hustle and Show/)).toBeTruthy()
    expect(screen.getByText("$0.25 → $0.25")).toBeTruthy()
    expect(screen.queryByText(/row cap/)).toBeNull()
  })

  it("a capped list says the total is a lower bound", () => {
    resource.data = { ...payload, purchases_truncated: true }
    render(<ClickPurchasesClient />)
    expect(screen.getByText(/lower bound/)).toBeTruthy()
  })

  it("an empty window says no sale followed — it does not conclude there were no clicks", () => {
    resource.data = { ...payload, purchases: [] }
    render(<ClickPurchasesClient />)
    expect(screen.getByText(/No click has been followed by a matching sale/)).toBeTruthy()
  })

  it("a failed refresh keeps the last read but says it is not current", () => {
    Object.assign(resource, { error: "HTTP 500", stale: true })
    render(<ClickPurchasesClient />)
    expect(screen.getByRole("alert").textContent).toMatch(/not current/)
  })

  it("no token → the token form, no figures", () => {
    Object.assign(resource, { token: "", data: null })
    render(<ClickPurchasesClient />)
    expect(screen.getByLabelText("Admin token")).toBeTruthy()
    expect(screen.queryByText(/Human clicks/)).toBeNull()
  })
})
