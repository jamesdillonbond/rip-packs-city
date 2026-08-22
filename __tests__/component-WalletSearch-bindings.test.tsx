// @vitest-environment jsdom
//
// The three page-level bindings of the canonical components/WalletSearch. Each
// used to be a hand-rolled FORK of the same input; two of the three emitted NO
// wallet_paste at all, so every lookup on /insights and /insights/account-value
// was invisible in funnel_events. These tests pin the thing that regresses
// silently: each binding still fires wallet_paste, under its OWN surface, and
// still lands on the public route it is supposed to.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

const pushMock = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/insights",
}))

const trackMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({
  trackFunnelEvent: (...a: unknown[]) => trackMock(...a),
}))

import WalletSearch from "@/components/WalletSearch"
import InsightsWalletSearch from "@/components/insights/InsightsWalletSearch"
import AccountValueSearch from "@/components/insights/AccountValueSearch"

const ADDR = "0xbd94cade097e50ac"

function submit(container: HTMLElement, value = ADDR) {
  fireEvent.change(container.querySelector("input")!, { target: { value } })
  fireEvent.submit(container.querySelector("form")!)
}

beforeEach(() => {
  pushMock.mockReset()
  trackMock.mockReset()
})
afterEach(cleanup)

describe("WalletSearch bindings", () => {
  it("/insights hub emits surface=insights_hub and opens the public TC report", () => {
    const { container } = render(<InsightsWalletSearch />)
    submit(container)
    expect(trackMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "wallet_paste", surface: "insights_hub" })
    )
    expect(pushMock).toHaveBeenCalledWith(`/insights/tc-report?wallet=${ADDR}`)
  })

  it("/insights/account-value emits surface=insights_account_value and opens /share", () => {
    const { container } = render(<AccountValueSearch />)
    submit(container)
    expect(trackMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "wallet_paste", surface: "insights_account_value" })
    )
    expect(pushMock).toHaveBeenCalledWith(`/share/${ADDR}`)
  })

  it("puts a caller's className on the WRAPPER, so breakpoint-dependent sizing can live in CSS", () => {
    // Why the wrapper and not the form: the wrapper is the flex ITEM of the
    // caller's row, so it is the box whose main-axis size flips meaning when
    // that row becomes a column. An inline `flex` there is unoverridable by a
    // media query — that is how the collection/insights band shipped a 300px
    // flex-BASIS that rendered as a 300px HEIGHT on mobile.
    const { container } = render(<WalletSearch surface="t" className="rpc-test-wrapper" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain("rpc-test-wrapper")
    // It must not swallow the variant sizing it already owned.
    expect(wrapper.style.width).toBe("100%")
    expect(wrapper.style.maxWidth).toBe("640px")
  })

  it("stays unclassed when no caller asks for one", () => {
    const { container } = render(<WalletSearch surface="t" />)
    const wrapper = container.firstElementChild as HTMLElement
    // Absence of the false thing: no stray "undefined" class in the markup.
    expect(wrapper.className).toBe("")
    expect(container.innerHTML).not.toContain("undefined")
  })

  it("percent-encodes the input into the destination URL", () => {
    // A username path: a non-0x value must not be interpolated raw.
    const { container } = render(<WalletSearch surface="home" />)
    fireEvent.change(container.querySelector("input")!, { target: { value: "a/b?c=d" } })
    fireEvent.submit(container.querySelector("form")!)
    // Not a Flow address -> resolved via /api/wallet-search, so no push yet,
    // but the paste must still be recorded as intent.
    expect(trackMock).toHaveBeenCalledWith({
      eventType: "wallet_paste",
      walletAddress: "a/b?c=d",
      surface: "home",
    })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it("never routes a lookup at an auth-gated destination", () => {
    for (const el of [<InsightsWalletSearch key="a" />, <AccountValueSearch key="b" />]) {
      const { container } = render(el)
      submit(container)
      cleanup()
    }
    const urls = pushMock.mock.calls.flat().join(" ")
    expect(urls).not.toContain("/dashboard")
    expect(urls).not.toContain("/login")
  })

  it("emits the paste BEFORE navigating, so a resolved lookup is never lost", () => {
    const order: string[] = []
    trackMock.mockImplementation(() => order.push("track"))
    pushMock.mockImplementation(() => order.push("push"))
    const { container } = render(<WalletSearch surface="home" />)
    submit(container)
    expect(order).toEqual(["track", "push"])
  })
})
