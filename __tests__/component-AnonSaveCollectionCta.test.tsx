// @vitest-environment jsdom
//
// 2026-11-17: the binder's account ask for a SIGNED-OUT visitor who has just seen their
// collection. It renders only when told to, logs one show per wallet, and its sign-up link
// returns the visitor to the same binder with the same ?wallet= so the signed-in save button
// can keep it.
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

const funnelMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent: (...a: unknown[]) => funnelMock(...a) }))
vi.mock("next/navigation", () => ({ usePathname: () => "/nba-top-shot/collection" }))
const usageMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => usageMock(...a) }))

import AnonSaveCollectionCta, { saveReturnPath } from "@/components/auth/AnonSaveCollectionCta"

afterEach(() => {
  cleanup()
  funnelMock.mockReset()
  usageMock.mockReset()
})

describe("AnonSaveCollectionCta", () => {
  it("renders nothing and logs nothing when the binder did not load for a signed-out reader", () => {
    const { container } = render(<AnonSaveCollectionCta show={false} wallet="someone" collection="nba-top-shot" />)
    expect(container.querySelector("[data-rpc-anon-save-cta]")).toBeNull()
    expect(usageMock).not.toHaveBeenCalled()
  })

  it("asks to keep the collection and returns to this binder with the same wallet after sign-up", () => {
    const { container } = render(<AnonSaveCollectionCta show wallet="knot bean" collection="nba-top-shot" />)
    expect(container.textContent).toMatch(/Is this your collection\?/)
    const href = container.querySelector("a")!.getAttribute("href") ?? ""
    const q = new URLSearchParams(href.split("?").slice(1).join("?"))
    expect(q.get("intent")).toBe("signup")
    expect(q.get("next")).toBe("/nba-top-shot/collection?wallet=knot%20bean")
    fireEvent.click(container.querySelector("a")!)
    expect(funnelMock).toHaveBeenCalledWith({ eventType: "signin_click", surface: "binder_save_signup" })
    expect(usageMock).toHaveBeenCalledWith("anon-save-cta-shown", { collection: "nba-top-shot" })
  })

  it("logs one show per wallet, not one per render", () => {
    const a = render(<AnonSaveCollectionCta show wallet="w1-once" collection="nfl-all-day" />)
    a.rerender(<AnonSaveCollectionCta show wallet="w1-once" collection="nfl-all-day" />)
    expect(usageMock).toHaveBeenCalledTimes(1)
  })

  it("saveReturnPath keeps the bare path when there is no wallet", () => {
    expect(saveReturnPath("/nba-top-shot/collection", "  ")).toBe("/nba-top-shot/collection")
    expect(saveReturnPath(null, "x")).toBeNull()
  })
})
