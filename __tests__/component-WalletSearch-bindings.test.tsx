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

  // ⛔ THE FRONT DOOR WAS FLOW-ONLY UNTIL 2026-09-19. The submit path gated on
  // /^0x[0-9a-fA-F]{16}$/, so a Candy MLB collector pasting their Solana wallet
  // fell through to the username resolver and was told "Couldn't find that
  // username." — while /share/<that exact address> already returned 200 with
  // $13.00 across 5 moments and real Arweave art. Nothing was missing but this
  // box's willingness to navigate.
  it("navigates a base58 (Solana/Candy) wallet to its share card", () => {
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    const { container } = render(<WalletSearch surface="t" />)
    submit(container, CANDY)
    expect(pushMock).toHaveBeenCalledWith(`/share/${CANDY}`)
  })

  it("⛔ sends base58 VERBATIM — folding the case would address a different wallet", () => {
    const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    const { container } = render(<WalletSearch surface="t" />)
    submit(container, CANDY)
    const pushed = pushMock.mock.calls[0][0] as string
    expect(pushed).toContain(CANDY)
    expect(pushed).not.toContain(CANDY.toLowerCase())
  })

  it("no-change control: a Flow address still goes straight to /share, unresolved", () => {
    // The Flow branch must be untouched by widening the gate — this is the
    // path ~100% of today's pastes take.
    const { container } = render(<WalletSearch surface="t" />)
    submit(container, ADDR)
    expect(pushMock).toHaveBeenCalledWith(`/share/${ADDR}`)
  })

  it("no-change control: a plain username still goes to the resolver, not to /share", async () => {
    // Widening the address gate must not swallow usernames — if it did, every
    // username lookup would navigate to a share card for a non-address.
    const { container } = render(<WalletSearch surface="t" />)
    submit(container, "trevor")
    expect(pushMock).not.toHaveBeenCalled()
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
