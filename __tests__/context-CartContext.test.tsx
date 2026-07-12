// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { renderHook, act } from "@testing-library/react"

// Exercises the cart reducer + derived state THROUGH the public provider/hook
// surface: add (with dedup + max-size + flowty kill-switch), remove, clear,
// totalPrice/itemCount derivation, offer mode, per-item status, and
// removeCompleted. track() is a fire-and-forget beacon — mocked to a spy so we
// can assert it fires without touching the network.

const track = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => track(...a) }))

import { CartProvider, useCart, CartItem } from "@/lib/cart/CartContext"

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(CartProvider, null, children)

function baseItem(overrides: Partial<CartItem> = {}): Omit<CartItem, "addedAt"> {
  return {
    listingResourceID: "L1",
    storefrontAddress: "0xseller",
    expectedPrice: 12.5,
    commissionRecipient: null,
    momentId: 1,
    playerName: "Damian Lillard",
    setName: "Base Set",
    serialNumber: 42,
    totalEditions: 15000,
    tier: "COMMON",
    thumbnailUrl: null,
    fmv: 20,
    source: "sniper",
    paymentToken: "DUC",
    cartMode: "buy",
    ...overrides,
  }
}

beforeEach(() => {
  track.mockClear()
  localStorage.clear()
})

describe("CartContext", () => {
  it("adds an item, derives itemCount + totalPrice, and fires a track beacon", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addToCart(baseItem({ listingResourceID: "A", expectedPrice: 10 })))
    act(() => result.current.addToCart(baseItem({ listingResourceID: "B", expectedPrice: 5.25 })))

    expect(result.current.itemCount).toBe(2)
    expect(result.current.totalPrice).toBeCloseTo(15.25, 5)
    expect(result.current.isInCart("A")).toBe(true)
    expect(result.current.isInCart("Z")).toBe(false)
    expect(track).toHaveBeenCalledWith("cart-add", expect.objectContaining({ source: "sniper" }))
  })

  it("deduplicates by listingResourceID", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addToCart(baseItem({ listingResourceID: "DUP" })))
    act(() => result.current.addToCart(baseItem({ listingResourceID: "DUP", expectedPrice: 999 })))
    expect(result.current.itemCount).toBe(1)
    expect(result.current.totalPrice).toBe(12.5)
  })

  it("caps the cart at 20 items", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => {
      for (let i = 0; i < 25; i++) {
        result.current.addToCart(baseItem({ listingResourceID: `item-${i}` }))
      }
    })
    expect(result.current.itemCount).toBe(20)
  })

  it("silently drops flowty adds while the marketplace flag is off (kill-switch)", () => {
    // NEXT_PUBLIC_FLOWTY_MARKETPLACE_ENABLED is unset in the test env → gated off.
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addToCart(baseItem({ listingResourceID: "F", marketplaceSource: "flowty" })))
    act(() => result.current.addToCart(baseItem({ listingResourceID: "T", marketplaceSource: "topshot" })))
    expect(result.current.itemCount).toBe(1)
    expect(result.current.isInCart("F")).toBe(false)
    expect(result.current.isInCart("T")).toBe(true)
  })

  it("removes and clears", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addToCart(baseItem({ listingResourceID: "A" })))
    act(() => result.current.addToCart(baseItem({ listingResourceID: "B" })))
    act(() => result.current.removeFromCart("A"))
    expect(result.current.itemCount).toBe(1)
    expect(result.current.isInCart("A")).toBe(false)
    act(() => result.current.clearCart())
    expect(result.current.itemCount).toBe(0)
  })

  it("addOffer stores it in offer mode with amount + expiry", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() =>
      result.current.addOffer({
        ...baseItem({ listingResourceID: "OFF" }),
        offerAmount: 33,
        offerExpiry: 1234567890,
      } as any)
    )
    expect(result.current.items[0].cartMode).toBe("offer")
    expect(result.current.items[0].offerAmount).toBe(33)
    expect(track).toHaveBeenCalledWith("cart-add", expect.objectContaining({ mode: "offer", offer: 33 }))
  })

  it("setOfferMode flips an existing buy item to offer mode", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addToCart(baseItem({ listingResourceID: "X" })))
    act(() => result.current.setOfferMode("X", "offer", 50, 999))
    expect(result.current.items[0].cartMode).toBe("offer")
    expect(result.current.items[0].offerAmount).toBe(50)
    expect(result.current.items[0].offerExpiry).toBe(999)
  })

  it("tracks per-item status and removeCompleted drops only 'success' items", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.addToCart(baseItem({ listingResourceID: "ok" })))
    act(() => result.current.addToCart(baseItem({ listingResourceID: "bad" })))
    act(() => {
      result.current.setItemStatus("ok", "success")
      result.current.setItemStatus("bad", "failed")
    })
    expect(result.current.purchaseStatus).toEqual({ ok: "success", bad: "failed" })

    act(() => result.current.removeCompleted())
    expect(result.current.isInCart("ok")).toBe(false)
    expect(result.current.isInCart("bad")).toBe(true)
  })

  it("setExecuting + resetStatuses manage the execution flag", () => {
    const { result } = renderHook(() => useCart(), { wrapper })
    act(() => result.current.setExecuting(true))
    expect(result.current.isExecuting).toBe(true)
    act(() => {
      result.current.setItemStatus("a", "pending")
      result.current.resetStatuses()
    })
    expect(result.current.isExecuting).toBe(false)
    expect(result.current.purchaseStatus).toEqual({})
  })

  it("useCart throws when used outside the provider", () => {
    // Render without the wrapper — the hook must guard.
    expect(() => renderHook(() => useCart())).toThrow(/must be used inside/)
  })
})
