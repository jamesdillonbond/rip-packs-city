// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

// /admin/visitor-journeys. Pins the page's honesty rules: the excluded bot /
// internal counts are stated beside the list; "returning" is shown against the
// visits that COULD be classified; an AI arrival is labelled as such; times
// are PT; a session expands into its event timeline.

const resource: any = {}
const urls: string[] = []
vi.mock("@/lib/admin/use-admin-resource", () => ({
  useAdminResource: (url: string) => { urls.push(url); return resource },
}))

import VisitorJourneysClient, { sourceLabel, fmtPt, type VisitorJourneysPayload } from "@/app/admin/visitor-journeys/VisitorJourneysClient"

const payload: VisitorJourneysPayload = {
  generated_at: "2026-10-03T15:00:00Z",
  window_hours: 24,
  totals: { sessions_seen: 5361, sessions_human: 2, sessions_excluded_bot: 5358, sessions_excluded_internal: 1, sessions_shown: 2, with_concierge: 1, with_wallet_paste: 1, with_email_capture: 0, signed_in: 0, returning: 1, with_visitor_id: 1, from_ai: 1 },
  ai_referrals_window: [{ source: "chatgpt", sessions: 1 }],
  ai_referrals_30d: [{ source: "chatgpt", sessions: 84 }],
  sessions: [
    { sid: "H", visitor_id: "V1", returning: true, first_at: "2026-10-03T14:00:24Z", last_at: "2026-10-03T14:14:25Z", n_events: 2, landing_ref: "utm_source=chatgpt.com", ai_source: "chatgpt", landing_path: "/nba-top-shot/collection", wallet: "0xba14e24d976f8484", signed_in: false, chatted: true, pasted: true, captured: false, clicked_out: false,
      events: [
        { at: "2026-10-03T14:00:24Z", src: "funnel", kind: "collection_view", detail: "/nba-top-shot/collection" },
        { at: "2026-10-03T14:00:55Z", src: "concierge", kind: "general", detail: "what is my collection worth" },
      ] },
    { sid: "G", visitor_id: null, returning: false, first_at: "2026-10-03T13:00:00Z", last_at: "2026-10-03T13:00:00Z", n_events: 1, landing_ref: null, ai_source: null, landing_path: "/", wallet: null, signed_in: false, chatted: false, pasted: false, captured: false, clicked_out: false, events: null },
  ],
}

afterEach(() => cleanup())
beforeEach(() => {
  urls.length = 0
  Object.assign(resource, {
    token: "tok", tokenInput: "", setTokenInput: vi.fn(), submitToken: vi.fn(),
    data: payload, loading: false, error: null, stale: false, refresh: vi.fn(),
  })
})

describe("VisitorJourneysClient", () => {
  it("states what it excluded and classifies returning only against visits with an id", () => {
    render(<VisitorJourneysClient />)
    expect(screen.getByText(/5358 bot \/ automated \/\s*smoke-test visits and 1 internal-account/)).toBeTruthy()
    expect(screen.getByText(/Returning: 1 of the\s+1 visits carrying a visitor id/)).toBeTruthy()
  })

  it("labels AI arrivals and renders PT, and expands a visit into its timeline", () => {
    render(<VisitorJourneysClient />)
    expect(screen.getByText("AI · chatgpt")).toBeTruthy()
    expect(screen.getByText("Oct 3, 7:00 AM PT")).toBeTruthy()
    expect(screen.queryByText(/what is my collection worth/)).toBeNull()
    fireEvent.click(screen.getByText("AI · chatgpt").closest("button")!)
    expect(screen.getByText(/what is my collection worth/)).toBeTruthy()
  })

  it("the ai filter keeps only AI arrivals; the window buttons re-key the read", () => {
    render(<VisitorJourneysClient />)
    fireEvent.click(screen.getByRole("button", { name: "ai" }))
    expect(screen.queryByText("direct / unknown")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "7d" }))
    expect(urls[urls.length - 1]).toBe("/api/admin/visitor-journeys?hours=168")
  })

  it("a failed read shows the error and does not render a board of zeros", () => {
    Object.assign(resource, { data: null, error: "admin_visitor_journeys: statement timeout" })
    render(<VisitorJourneysClient />)
    expect(screen.getByRole("alert").textContent).toMatch(/statement timeout/)
    expect(screen.queryByText("Human visits")).toBeNull()
  })

  it("sourceLabel: utm, share, external ref, direct", () => {
    expect(sourceLabel({ ai_source: null, landing_ref: "utm_source=x&utm_medium=y" })).toBe("utm · x")
    expect(sourceLabel({ ai_source: null, landing_ref: "share_ref=abc" })).toBe("share · abc")
    expect(sourceLabel({ ai_source: null, landing_ref: "ref=https://t.co/abc" })).toBe("ref · t.co")
    expect(sourceLabel({ ai_source: null, landing_ref: null })).toBe("direct / unknown")
    expect(fmtPt(null)).toBe("—")
  })

  it("asks for the token before reading", () => {
    Object.assign(resource, { token: null, data: null })
    render(<VisitorJourneysClient />)
    expect(screen.getByLabelText("Admin token")).toBeTruthy()
  })
})
