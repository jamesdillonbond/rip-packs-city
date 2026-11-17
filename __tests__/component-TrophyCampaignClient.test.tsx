// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

// /admin/trophy-campaign. Pins the two honesty rules in the client header:
// a backfilled date renders with "≤" (a ceiling, not an observation), and a
// pre-tracking pin's campaign reads as unknown, not "no campaign". Internal
// accounts are hidden until asked for.

const resource: any = {}
vi.mock("@/lib/admin/use-admin-resource", () => ({
  useAdminResource: () => resource,
}))

import TrophyCampaignClient, { fmtPt, type TrophyCampaignPayload } from "@/app/admin/trophy-campaign/TrophyCampaignClient"

const payload: TrophyCampaignPayload = {
  generated_at: "2026-09-27T16:00:00Z",
  totals: { accounts: 4, accounts_external: 3, started_external: 2, completed_external: 1, not_started_external: 1, started_internal: 1, completed_internal: 1 },
  users: [
    { user_id: "a", email: "done@x.com", is_internal: false, internal_reason: null, status: "completed", started_at: "2026-06-05T04:20:00Z", started_at_source: "backfill_upper_bound", completed_at: "2026-06-05T04:21:00Z", completed_at_source: "backfill_upper_bound", current_slots: 6, first_pin_event_at: null, first_pin_utm_source: null, first_pin_utm_campaign: null, first_pin_share_ref: null },
    { user_id: "b", email: "new@x.com", is_internal: false, internal_reason: null, status: "started", started_at: "2026-09-28T01:00:00Z", started_at_source: "observed", completed_at: null, completed_at_source: null, current_slots: 2, first_pin_event_at: "2026-09-28T01:00:00Z", first_pin_utm_source: "email", first_pin_utm_campaign: "trophy-push", first_pin_share_ref: null },
    { user_id: "q", email: "qa@x.com", is_internal: true, internal_reason: "QA", status: "completed", started_at: "2026-09-10T00:00:00Z", started_at_source: "observed", completed_at: "2026-09-10T00:05:00Z", completed_at_source: "observed", current_slots: 6, first_pin_event_at: null, first_pin_utm_source: null, first_pin_utm_campaign: null, first_pin_share_ref: null },
  ],
  not_started: [{ user_id: "c", email: "todo@x.com", is_internal: false, internal_reason: null, signed_up_at: "2026-09-01T00:00:00Z", last_sign_in_at: null }],
  daily: [{ day_pt: "2026-09-27", started_external: 1, completed_external: 0, started_internal: 0, completed_internal: 0, includes_backfill: false }],
}

afterEach(() => cleanup())

beforeEach(() => {
  Object.assign(resource, {
    token: "tok", tokenInput: "", setTokenInput: vi.fn(), submitToken: vi.fn(),
    data: payload, loading: false, error: null, stale: false, refresh: vi.fn(),
  })
})

describe("TrophyCampaignClient", () => {
  it("fmtPt renders Pacific time and marks a backfilled ceiling with ≤", () => {
    expect(fmtPt("2026-06-05T04:20:00Z", "observed")).toBe("Jun 4, 2026, 9:20 PM PT")
    expect(fmtPt("2026-06-05T04:20:00Z", "backfill_upper_bound")).toBe("≤ Jun 4, 2026, 9:20 PM PT")
    expect(fmtPt(null)).toBe("—")
  })

  it("renders the external totals and the finished / started / not-started lists", () => {
    render(<TrophyCampaignClient />)
    expect(screen.getByText("Finished — 1")).toBeTruthy()
    expect(screen.getByText("Started, not finished — 1")).toBeTruthy()
    expect(screen.getByText("Not started — 1")).toBeTruthy()
    expect(screen.getByText("done@x.com")).toBeTruthy()
    expect(screen.getByText("todo@x.com")).toBeTruthy()
  })

  it("a pre-tracking pin's campaign is unknown, not 'no campaign'; a tracked one shows its utm", () => {
    render(<TrophyCampaignClient />)
    expect(screen.getByText("— (pinned before tracking)")).toBeTruthy()
    expect(screen.getByText("trophy-push · email")).toBeTruthy()
    expect(screen.queryByText("direct / no campaign")).toBeNull()
  })

  it("hides internal accounts until the toggle is on", () => {
    render(<TrophyCampaignClient />)
    expect(screen.queryByText("qa@x.com")).toBeNull()
    fireEvent.click(screen.getByLabelText("Show internal accounts"))
    expect(screen.getByText("qa@x.com")).toBeTruthy()
  })

  it("shows the token form when no token is held", () => {
    resource.token = ""
    render(<TrophyCampaignClient />)
    expect(screen.getByLabelText("Admin token")).toBeTruthy()
  })

  it("a failed refresh over retained data says the figures are not current", () => {
    resource.error = "HTTP 500: boom"
    resource.stale = true
    render(<TrophyCampaignClient />)
    expect(screen.getByRole("alert").textContent).toContain("not current")
  })
})
