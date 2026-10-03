// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

// /admin/visitor-journeys — the states the first suite
// (component-VisitorJourneysClient.test.tsx) does not reach: a failed refresh
// over a previous read (the figures must be called stale, not shown as
// current), a truncated list (must say "newest N of M"), empty referral lists
// ("none", not a blank), the engaged filter and its empty state, every
// engagement tag, and the token form. Added 2026-10-03 when the page's
// untested branches took the component branch-coverage gate below threshold.

const resource: any = {}
vi.mock("@/lib/admin/use-admin-resource", () => ({
  useAdminResource: () => resource,
}))

import VisitorJourneysClient, {
  sourceLabel,
  fmtPt,
  type JourneySession,
  type VisitorJourneysPayload,
} from "@/app/admin/visitor-journeys/VisitorJourneysClient"

function session(over: Partial<JourneySession>): JourneySession {
  return {
    sid: "S", visitor_id: null, returning: false,
    first_at: "2026-10-03T13:00:00Z", last_at: "2026-10-03T13:00:00Z",
    n_events: 1, landing_ref: null, ai_source: null, landing_path: null, wallet: null,
    signed_in: false, chatted: false, pasted: false, captured: false, clicked_out: false,
    events: null, ...over,
  }
}

function payload(sessions: JourneySession[], totals: Partial<VisitorJourneysPayload["totals"]> = {}): VisitorJourneysPayload {
  return {
    generated_at: "2026-10-03T15:00:00Z",
    window_hours: 6,
    totals: {
      sessions_seen: 10, sessions_human: sessions.length, sessions_excluded_bot: 8, sessions_excluded_internal: 0,
      sessions_shown: sessions.length, with_concierge: 0, with_wallet_paste: 0, with_email_capture: 0,
      signed_in: 0, returning: 0, with_visitor_id: 0, from_ai: 0, ...totals,
    },
    ai_referrals_window: [],
    ai_referrals_30d: [],
    sessions,
  }
}

afterEach(() => cleanup())
beforeEach(() => {
  for (const k of Object.keys(resource)) delete resource[k]
  Object.assign(resource, {
    token: "tok", tokenInput: "", setTokenInput: vi.fn(), submitToken: vi.fn(),
    data: payload([session({})]), loading: false, error: null, stale: false, refresh: vi.fn(),
  })
})

describe("VisitorJourneysClient — states the first suite does not reach", () => {
  it("a failed refresh over an earlier read says the figures are NOT current", () => {
    Object.assign(resource, { error: "admin_visitor_journeys: statement timeout", stale: true })
    render(<VisitorJourneysClient />)
    const alert = screen.getByRole("alert").textContent ?? ""
    expect(alert).toMatch(/statement timeout/)
    expect(alert).toMatch(/not current/)
    // The old board is still shown, under that warning — not silently as live.
    expect(screen.getByText("Human visits")).toBeTruthy()
  })

  it("a fresh read with no error carries no stale warning", () => {
    render(<VisitorJourneysClient />)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText(/not current/)).toBeNull()
  })

  it("empty referral lists read 'none', and a truncated list says newest N of M", () => {
    Object.assign(resource, {
      data: payload([session({ sid: "A" }), session({ sid: "B" })], { sessions_human: 40, sessions_shown: 2 }),
    })
    render(<VisitorJourneysClient />)
    expect(screen.getByText(/This window:\s*none/)).toBeTruthy()
    expect(screen.getByText(/30 days \(human funnel visits\):\s*none/)).toBeTruthy()
    expect(screen.getByText(/Visits — 2 \(newest 2 of 40\)/)).toBeTruthy()
  })

  it("the engaged filter keeps only visits that did something, and says so when none did", () => {
    Object.assign(resource, {
      data: payload([
        session({ sid: "idle", landing_path: "/idle" }),
        session({ sid: "signed", landing_path: "/signed", signed_in: true }),
      ]),
    })
    render(<VisitorJourneysClient />)
    fireEvent.click(screen.getByRole("button", { name: "engaged" }))
    expect(screen.getByText("/signed")).toBeTruthy()
    expect(screen.queryByText("/idle")).toBeNull()

    cleanup()
    Object.assign(resource, { data: payload([session({ sid: "idle", landing_path: "/idle" })]) })
    render(<VisitorJourneysClient />)
    fireEvent.click(screen.getByRole("button", { name: "engaged" }))
    expect(screen.getByText(/No human visits match this filter/)).toBeTruthy()
  })

  it("renders every engagement tag, a paste without a wallet, and an event with no detail", () => {
    Object.assign(resource, {
      data: payload([
        session({
          sid: "T", landing_path: "/t", signed_in: true, captured: true, clicked_out: true, pasted: true, wallet: null,
          events: [{ at: "not-a-date", src: "click", kind: "outbound", detail: null }],
        }),
      ]),
    })
    render(<VisitorJourneysClient />)
    for (const t of ["signed in", "email", "clicked out", "paste"]) expect(screen.getByText(t)).toBeTruthy()
    fireEvent.click(screen.getByText("/t").closest("button")!)
    const item = screen.getByText(/click:outbound/).closest("li")!
    // An unparseable timestamp renders as a dash, never "Invalid Date".
    expect(item.textContent).toMatch(/^—/)
    expect(item.textContent).not.toMatch(/Invalid/)
    expect(item.textContent).not.toMatch(/ — $/)
  })

  it("a loading read says so", () => {
    Object.assign(resource, { loading: true, data: null })
    render(<VisitorJourneysClient />)
    expect(screen.getByText("Loading…")).toBeTruthy()
  })

  it("the token form submits through the hook and shows a token error", () => {
    const submitToken = vi.fn()
    const setTokenInput = vi.fn()
    Object.assign(resource, { token: null, data: null, error: "invalid token", submitToken, setTokenInput })
    render(<VisitorJourneysClient />)
    fireEvent.change(screen.getByLabelText("Admin token"), { target: { value: "abc" } })
    expect(setTokenInput).toHaveBeenCalledWith("abc")
    fireEvent.click(screen.getByRole("button", { name: "Authenticate" }))
    expect(submitToken).toHaveBeenCalledTimes(1)
    expect(screen.getByText("invalid token")).toBeTruthy()
  })

  it("sourceLabel falls back to the raw ref (capped) when it is none of utm/share/url", () => {
    expect(sourceLabel({ ai_source: null, landing_ref: "x".repeat(60) })).toBe("x".repeat(40))
    expect(fmtPt("not-a-date")).toBe("—")
  })
})
