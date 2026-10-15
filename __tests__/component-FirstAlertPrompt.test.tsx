// @vitest-environment jsdom
//
// The dashboard's "Set up your first alert" card claims the collector has NO
// alerts. That claim is only true when BOTH alert reads answered and both were
// empty — a failed read is "we don't know", never "none" (honesty canon).
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))

const responses: Record<string, { ok: boolean; json: unknown }> = {}
vi.mock("@/lib/analytics/fetch-json", () => ({
  fetchJson: (url: string) => Promise.resolve(responses[url.split("?")[0]]),
}))

import FirstAlertPrompt, { firstAlertState } from "@/components/alerts/FirstAlertPrompt"

afterEach(cleanup)

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
})
