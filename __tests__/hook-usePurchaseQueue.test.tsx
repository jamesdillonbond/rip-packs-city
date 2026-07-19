// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// usePurchaseQueue orchestrates cart checkout: detects the wallet, fails the
// whole batch up-front for Dapper, marks flowty items 'unavailable' while the
// kill-switch is off, submits FCL txns for the rest, and classifies errors
// (sniped / insufficient_balance) — breaking the loop on insufficient balance.
// We mock FCL, the cadence templates, the cart, and fetch to drive each branch.

const mutate = vi.fn()
const onceExecuted = vi.fn().mockResolvedValue(undefined)
let snapshotValue: unknown

vi.mock("@onflow/fcl", () => ({
  mutate: (...a: unknown[]) => mutate(...a),
  tx: () => ({ onceExecuted: () => onceExecuted() }),
  currentUser: { snapshot: () => Promise.resolve(snapshotValue) },
  authz: {},
  arg: (v: unknown) => v,
  t: { Address: "Address", UInt64: "UInt64", UFix64: "UFix64" },
}))
vi.mock("@/lib/chains/flow/cadence/purchase-moment-flow-wallet", () => ({ PURCHASE_MOMENT_FLOW_WALLET_CADENCE: "TX" }))
vi.mock("@/lib/chains/flow/cadence/make-offer-flowty", () => ({ MAKE_OFFER_FLOWTY_CADENCE: "OFFER" }))

// Controllable cart double.
const cartState = {
  items: [] as any[],
  isExecuting: false,
  setExecuting: vi.fn((v: boolean) => { cartState.isExecuting = v }),
  resetStatuses: vi.fn(),
  setItemStatus: vi.fn(),
  purchaseStatus: {},
}
vi.mock("@/lib/cart/CartContext", () => ({ useCart: () => cartState }))

import { usePurchaseQueue } from "@/lib/cart/usePurchaseQueue"

function item(overrides: Record<string, unknown> = {}) {
  return {
    listingResourceID: "L1",
    storefrontAddress: "0xseller",
    expectedPrice: 12.5,
    commissionRecipient: null,
    momentId: 7,
    playerName: "P",
    setName: "S",
    serialNumber: 1,
    totalEditions: 100,
    tier: "COMMON",
    thumbnailUrl: null,
    fmv: 20,
    source: "sniper",
    paymentToken: "DUC",
    cartMode: "buy",
    ...overrides,
  } as any
}

beforeEach(() => {
  mutate.mockReset()
  onceExecuted.mockClear()
  cartState.isExecuting = false
  cartState.setExecuting.mockClear()
  cartState.resetStatuses.mockClear()
  cartState.setItemStatus.mockClear()
  snapshotValue = { addr: "0xbuyer", services: [] } // flow_wallet by default
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }))
})

describe("usePurchaseQueue", () => {
  it("returns [] for an empty item list without touching the cart", async () => {
    const { result } = renderHook(() => usePurchaseQueue())
    let out: unknown[] = [{}]
    await act(async () => { out = await result.current.executePurchase([]) })
    expect(out).toEqual([])
    expect(cartState.setExecuting).not.toHaveBeenCalled()
  })

  it("fails the whole batch with dapper_not_supported for a Dapper wallet", async () => {
    snapshotValue = { addr: "0xbuyer", services: [{ provider: { name: "Dapper Wallet" } }] }
    const { result } = renderHook(() => usePurchaseQueue())
    let out: any[] = []
    await act(async () => {
      out = await result.current.executePurchase([item({ listingResourceID: "A" }), item({ listingResourceID: "B" })])
    })
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.status === "failed" && r.errorClass === "dapper_not_supported")).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    expect(cartState.setExecuting).toHaveBeenLastCalledWith(false)
  })

  it("marks flowty items 'unavailable' while the kill-switch is off (no FCL submit)", async () => {
    const { result } = renderHook(() => usePurchaseQueue())
    let out: any[] = []
    await act(async () => {
      out = await result.current.executePurchase([item({ marketplaceSource: "flowty" })])
    })
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe("unavailable")
    expect(mutate).not.toHaveBeenCalled()
    expect(cartState.setItemStatus).toHaveBeenCalledWith("L1", "unavailable")
  })

  it("submits an FCL tx and reports success", async () => {
    mutate.mockResolvedValue("0xTXID")
    const { result } = renderHook(() => usePurchaseQueue())
    let out: any[] = []
    await act(async () => {
      out = await result.current.executePurchase([item()])
    })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(out[0]).toMatchObject({ status: "success", txId: "0xTXID", walletProvider: "flow_wallet" })
    expect(cartState.setItemStatus).toHaveBeenCalledWith("L1", "success")
  })

  it("classifies a vanished listing as 'sniped'", async () => {
    mutate.mockRejectedValue(new Error("could not borrow listing with id"))
    const { result } = renderHook(() => usePurchaseQueue())
    let out: any[] = []
    await act(async () => {
      out = await result.current.executePurchase([item()])
    })
    expect(out[0].status).toBe("sniped")
    expect(out[0].errorClass).toBe("sniped")
  })

  it("breaks the loop on insufficient_balance so later items are not attempted", async () => {
    mutate.mockRejectedValueOnce(new Error("insufficient balance in vault"))
    const { result } = renderHook(() => usePurchaseQueue())
    let out: any[] = []
    await act(async () => {
      out = await result.current.executePurchase([
        item({ listingResourceID: "A" }),
        item({ listingResourceID: "B" }),
      ])
    })
    // Only the first item ran; the loop broke before item B.
    expect(out).toHaveLength(1)
    expect(out[0].errorClass).toBe("insufficient_balance")
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it("is a no-op when the cart is already executing", async () => {
    cartState.isExecuting = true
    const { result } = renderHook(() => usePurchaseQueue())
    let out: any[] = [{}]
    await act(async () => { out = await result.current.executePurchase([item()]) })
    expect(out).toEqual([])
    expect(mutate).not.toHaveBeenCalled()
  })
})
