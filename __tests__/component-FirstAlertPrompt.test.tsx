// @vitest-environment jsdom
//
// The dashboard's "Set up your first alert" card claims the collector has NO
// alerts. That claim is only true when BOTH alert reads answered and both were
// empty — a failed read is "we don't know", never "none" (honesty canon).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))

const responses: Record<string, { ok: boolean; json: unknown }> = {}
vi.mock("@/lib/analytics/fetch-json", () => ({
  fetchJson: (url: string) => Promise.resolve(responses[url.split("?")[0]]),
}))

import FirstAlertPrompt, {
  firstAlertState,
  firstAlertTooSoon,
  resetFirstAlertPageLoad,
  FIRST_ALERT_DELAY_MS,
  FIRST_ALERT_MAX_SHOWS,
} from "@/components/alerts/FirstAlertPrompt"
import { track } from "@/lib/telemetry/track"

// Every test but the first-visit one is a RETURNING browser (seen 2 days ago).
beforeEach(() => {
  localStorage.setItem("rpc_first_alert_first_seen", String(Date.now() - 2 * 24 * 3600 * 1000))
  resetFirstAlertPageLoad()
  vi.mocked(track).mockClear()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

const ok = (json: unknown) => ({ ok: true, json })
const failed = { ok: false, json: null }

describe("firstAlertState", () => {
  it("shows only when both reads are ok and empty", () => {
    expect(firstAlertState(ok([]), ok({ subscriptions: [] }))).toBe("show")
  })
  it("does not claim 'no alerts' when either read FAILED", () => {
    expect(firstAlertState(failed, ok({ subscriptions: [] }))).toBe("hide")
    expect(firstAlertState(ok([]), failed)).toBe("hide")
  })
  it("hides once the collector has any alert of either kind", () => {
    expect(firstAlertState(ok([{ id: 1 }]), ok({ subscriptions: [] }))).toBe("hide")
    expect(firstAlertState(ok([]), ok({ subscriptions: [{ id: 2 }] }))).toBe("hide")
  })
  it("treats an unexpected body shape as unknown, not empty", () => {
    expect(firstAlertState(ok({ error: "x" }), ok({ subscriptions: [] }))).toBe("hide")
    expect(firstAlertState(ok([]), ok({}))).toBe("hide")
  })
})

describe("FirstAlertPrompt", () => {
  it("renders the card linking to /alerts for an account with no alerts", async () => {
    responses["/api/alerts"] = ok([])
    responses["/api/alerts/subscriptions"] = ok({ subscriptions: [] })
    const { container } = render(<FirstAlertPrompt />)
    await waitFor(() => expect(container.querySelector("[data-rpc-first-alert]")).toBeTruthy())
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/alerts")
  })

  it("renders nothing when the alerts read failed", async () => {
    responses["/api/alerts"] = failed
    responses["/api/alerts/subscriptions"] = ok({ subscriptions: [] })
    const { container } = render(<FirstAlertPrompt />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("[data-rpc-first-alert]")).toBeNull()
  })

  // 2026-10-31: blaise_27 saw the card 4 times in 2 days without acting — it became wallpaper.
  it(`stops showing after ${FIRST_ALERT_MAX_SHOWS} dashboard loads in a browser`, async () => {
    responses["/api/alerts"] = ok([])
    responses["/api/alerts/subscriptions"] = ok({ subscriptions: [] })
    for (let i = 0; i < FIRST_ALERT_MAX_SHOWS; i++) {
      const { container } = render(<FirstAlertPrompt />)
      await waitFor(() => expect(container.querySelector("[data-rpc-first-alert]")).toBeTruthy())
      cleanup()
      resetFirstAlertPageLoad() // the next render is the next dashboard load
    }
    const { container } = render(<FirstAlertPrompt />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("[data-rpc-first-alert]")).toBeNull()
  })

  it("'Not now' hides it now and on the next load", async () => {
    responses["/api/alerts"] = ok([])
    responses["/api/alerts/subscriptions"] = ok({ subscriptions: [] })
    const first = render(<FirstAlertPrompt />)
    await waitFor(() => expect(first.container.querySelector("[data-rpc-first-alert]")).toBeTruthy())
    fireEvent.click(first.getByRole("button", { name: /hide the alert suggestion/i }))
    expect(first.container.querySelector("[data-rpc-first-alert]")).toBeNull()
    cleanup()
    resetFirstAlertPageLoad()
    const { container } = render(<FirstAlertPrompt />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("[data-rpc-first-alert]")).toBeNull()
  })

  // 2026-11-10: new members saw this beside the challenge invite on their very
  // first dashboard and acted on the challenge, not this (84 shows, 2 clicks).
  it("waits on a browser's first dashboard visit", async () => {
    localStorage.removeItem("rpc_first_alert_first_seen")
    responses["/api/alerts"] = ok([])
    responses["/api/alerts/subscriptions"] = ok({ subscriptions: [] })
    const { container } = render(<FirstAlertPrompt />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("[data-rpc-first-alert]")).toBeNull()
    expect(localStorage.getItem("rpc_first_alert_first_seen")).not.toBeNull()
    expect(localStorage.getItem("rpc_first_alert_shows")).toBeNull()
  })

  // 2026-11-10: the dashboard mounted the card twice per load — two "shown"
  // events and two counts each time.
  it("a second mount in the same page load neither counts again nor logs again", async () => {
    responses["/api/alerts"] = ok([])
    responses["/api/alerts/subscriptions"] = ok({ subscriptions: [] })
    const a = render(<FirstAlertPrompt />)
    await waitFor(() => expect(a.container.querySelector("[data-rpc-first-alert]")).toBeTruthy())
    cleanup()
    const b = render(<FirstAlertPrompt />)
    await waitFor(() => expect(b.container.querySelector("[data-rpc-first-alert]")).toBeTruthy())
    expect(localStorage.getItem("rpc_first_alert_shows")).toBe("1")
    expect(vi.mocked(track).mock.calls.filter((c) => c[0] === "first-alert-prompt-shown")).toHaveLength(1)
  })
})

describe("firstAlertTooSoon", () => {
  it("waits with no first-seen stamp and inside the delay; not after it", () => {
    const now = 1_000_000_000_000
    expect(firstAlertTooSoon(null, now)).toBe(true)
    expect(firstAlertTooSoon(now - FIRST_ALERT_DELAY_MS + 1000, now)).toBe(true)
    expect(firstAlertTooSoon(now - FIRST_ALERT_DELAY_MS, now)).toBe(false)
  })
})
