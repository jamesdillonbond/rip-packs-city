import { describe, it, expect, vi, beforeEach } from "vitest"

// The one wallet-connect module (admin only). What matters: discovery is set at
// CONNECT time (never on import), the transaction sent is DELIVER_BATCH_CADENCE with
// the plan's arguments in order, and a batch is only reported sent once it SEALS
// without an error.

const fcl = vi.hoisted(() => {
  const put = vi.fn()
  const self = {
    put,
    config: vi.fn(() => ({ put })),
    authenticate: vi.fn(),
    unauthenticate: vi.fn(),
    mutate: vi.fn(),
    onceSealed: vi.fn(),
    tx: vi.fn(() => ({ onceSealed: () => self.onceSealed() })),
    arg: vi.fn((value: unknown, type: unknown) => ({ value, type })),
    t: { Address: "Address", UInt64: "UInt64", Array: (x: string) => `Array(${x})` },
  }
  return self
})
vi.mock("@onflow/fcl", () => fcl)
vi.mock("@/lib/chains/flow/flow", () => ({ initFcl: vi.fn() }))

import { connectAdminWallet, disconnectAdminWallet, prepareWalletConnect, sendDeliveryBatch } from "@/lib/giveaways/admin-wallet"
import { DELIVER_BATCH_CADENCE, DELIVER_GAS_LIMIT } from "@/lib/giveaways/deliver-cadence"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("giveaways/admin-wallet", () => {
  it("importing the module configures no wallet discovery", () => {
    expect(fcl.put).not.toHaveBeenCalledWith("discovery.wallet", expect.anything())
  })

  it("WalletConnect (the Flow Wallet mobile app) is configured in the browser when a project id exists", () => {
    // this suite runs in node: no window, so nothing is configured
    expect(prepareWalletConnect("abc")).toBe(false)
    expect(fcl.put).not.toHaveBeenCalled()
    vi.stubGlobal("window", {})
    try {
      expect(prepareWalletConnect("")).toBe(false)
      expect(fcl.put).not.toHaveBeenCalled()
      expect(prepareWalletConnect("abc")).toBe(true)
      expect(fcl.put).toHaveBeenCalledWith("walletconnect.projectId", "abc")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("connect sets discovery, authenticates, and returns the lowercased address", async () => {
    fcl.authenticate.mockResolvedValueOnce({ addr: "0xD96DC67AE64EE202" })
    expect(await connectAdminWallet()).toBe("0xd96dc67ae64ee202")
    expect(fcl.put).toHaveBeenCalledWith("discovery.wallet", "https://fcl-discovery.onflow.org/authn")
  })

  it("connect without an address is an error", async () => {
    fcl.authenticate.mockResolvedValueOnce({ addr: null })
    await expect(connectAdminWallet()).rejects.toThrow(/did not return an address/)
    fcl.authenticate.mockResolvedValueOnce(undefined)
    await expect(connectAdminWallet()).rejects.toThrow(/did not return an address/)
  })

  it("disconnect unauthenticates", async () => {
    await disconnectAdminWallet()
    expect(fcl.unauthenticate).toHaveBeenCalled()
  })

  it("sends the batch transaction with the plan's arguments in order, and waits for the seal", async () => {
    fcl.mutate.mockResolvedValueOnce("tx1")
    fcl.onceSealed.mockResolvedValueOnce({ statusCode: 0, errorMessage: "" })
    const r = await sendDeliveryBatch({ child: "0x00000000000000aa", providerControllerID: "70" }, { momentIDs: ["1", "2"], recipients: ["0x01", "0x02"] })
    expect(r).toEqual({ txId: "tx1" })
    const call = fcl.mutate.mock.calls[0][0] as { cadence: string; limit: number; args: (a: typeof fcl.arg, t: typeof fcl.t) => unknown[] }
    expect(call.cadence).toBe(DELIVER_BATCH_CADENCE)
    expect(call.limit).toBe(DELIVER_GAS_LIMIT)
    expect(call.args(fcl.arg, fcl.t)).toEqual([
      { value: "0x00000000000000aa", type: "Address" },
      { value: "70", type: "UInt64" },
      { value: ["1", "2"], type: "Array(UInt64)" },
      { value: ["0x01", "0x02"], type: "Array(Address)" },
    ])
    expect(fcl.tx).toHaveBeenCalledWith("tx1")
  })

  it("a reverted transaction is an error, never 'sent'", async () => {
    fcl.mutate.mockResolvedValueOnce("tx2")
    fcl.onceSealed.mockResolvedValueOnce({ statusCode: 1, errorMessage: "panic: Cannot withdraw: Moment is locked" })
    await expect(
      sendDeliveryBatch({ child: "0x00000000000000aa", providerControllerID: "70" }, { momentIDs: ["1"], recipients: ["0x01"] }),
    ).rejects.toThrow(/tx2 failed: panic: Cannot withdraw/)
    fcl.mutate.mockResolvedValueOnce("tx3")
    fcl.onceSealed.mockResolvedValueOnce({ statusCode: 1 })
    await expect(
      sendDeliveryBatch({ child: "0x00000000000000aa", providerControllerID: "70" }, { momentIDs: ["1"], recipients: ["0x01"] }),
    ).rejects.toThrow(/tx3 failed: status 1/)
  })
})
