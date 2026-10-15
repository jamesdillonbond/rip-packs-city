// @vitest-environment jsdom
//
// The share card's sign-up button must (a) bring the visitor back to THIS
// wallet's card after login, where the signed-in save button lives, and
// (b) log the click — the plain <a href="/login"> it replaced did neither
// (10-08..10-14: 10 wallet pastes, 0 recorded sign-in clicks).
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

const trackMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent: (...a: unknown[]) => trackMock(...a) }))

import ShareSignUpLink from "@/app/share/[wallet]/ShareSignUpLink"

afterEach(cleanup)

describe("ShareSignUpLink", () => {
  it("returns to the same share card after login", () => {
    const { container } = render(<ShareSignUpLink wallet="0xb4ce555fbc2ad619" />)
    const href = container.querySelector("a")?.getAttribute("href") ?? ""
    expect(href.startsWith("/login?next=")).toBe(true)
    expect(new URLSearchParams(href.split("?")[1]).get("next")).toBe("/share/0xb4ce555fbc2ad619")
  })

  it("keeps a case-sensitive Solana key intact through the round trip", () => {
    const key = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
    const { container } = render(<ShareSignUpLink wallet={key} />)
    const href = container.querySelector("a")?.getAttribute("href") ?? ""
    expect(new URLSearchParams(href.split("?")[1]).get("next")).toBe(`/share/${key}`)
  })

  it("logs a signin_click with its own surface", () => {
    const { container } = render(<ShareSignUpLink wallet="0xb4ce555fbc2ad619" />)
    fireEvent.click(container.querySelector("a") as HTMLAnchorElement)
    expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: "signin_click", surface: "share_cta" }))
  })
})
