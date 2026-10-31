// @vitest-environment jsdom
//
// 2026-10-31: Sniper hunters never met the alert offer (shashmeister re-ran one search
// for 9 days, no alert). After a few real filter changes, with filters an alert can carry,
// the Sniper offers the alert in place. Pins: the threshold, the "nothing to alert on"
// case, and that a dismissal sticks.
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))

import SniperAlertNudge, { alertHrefHasCriteria, shouldNudge, NUDGE_AFTER_CHANGES } from "@/components/sniper/SniperAlertNudge"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const HREF = "/alerts?from=sniper&collection=95f28a17-224a-4025-96ad-adf8a4c63bfd&maxPrice=5&minDiscount=15"
const BARE = "/alerts?from=sniper&collection=95f28a17-224a-4025-96ad-adf8a4c63bfd"

describe("shouldNudge", () => {
  it("waits for the threshold of real changes", () => {
    expect(shouldNudge(NUDGE_AFTER_CHANGES - 1, HREF, false)).toBe(false)
    expect(shouldNudge(NUDGE_AFTER_CHANGES, HREF, false)).toBe(true)
  })
  it("never offers an alert with nothing in it (collection only, or no href)", () => {
    expect(alertHrefHasCriteria(BARE)).toBe(false)
    expect(shouldNudge(10, BARE, false)).toBe(false)
    expect(shouldNudge(10, null, false)).toBe(false)
  })
  it("respects a dismissal", () => {
    expect(shouldNudge(10, HREF, true)).toBe(false)
  })
})

describe("SniperAlertNudge", () => {
  it("links the prefilled /alerts page and stays dismissed after 'Not now'", async () => {
    const a = render(<SniperAlertNudge alertHref={HREF} changes={NUDGE_AFTER_CHANGES} />)
    const link = await a.findByRole("link", { name: /alert me on these filters/i })
    expect(link.getAttribute("href")).toBe(HREF)
    fireEvent.click(a.getByRole("button", { name: /dismiss/i }))
    expect(a.container.querySelector("[data-rpc-sniper-alert-nudge]")).toBeNull()
    cleanup()
    const b = render(<SniperAlertNudge alertHref={HREF} changes={NUDGE_AFTER_CHANGES + 5} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(b.container.querySelector("[data-rpc-sniper-alert-nudge]")).toBeNull()
  })
  it("renders nothing below the threshold", async () => {
    const { container } = render(<SniperAlertNudge alertHref={HREF} changes={1} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("[data-rpc-sniper-alert-nudge]")).toBeNull()
  })
})
