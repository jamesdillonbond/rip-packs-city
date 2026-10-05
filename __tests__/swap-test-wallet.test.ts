import { describe, it, expect, vi, beforeEach } from "vitest"

// The wallet half of the swap test. What matters: the transaction sent is SWAP_CADENCE
// with the plan's arguments in order and wallet A as the FIRST authorizer; wallet B's
// signature comes from the relay and carries the key that actually signed; the
// co-signer refuses anything that isn't the swap transaction; nothing is reported
// done until the transaction SEALS without error.

const fcl = vi.hoisted(() => {
  const self = {
    config: vi.fn(() => ({ put: vi.fn(), delete: vi.fn() })),
    authenticate: vi.fn(),
    unauthenticate: vi.fn(),
    mutate: vi.fn(),
    onceSealed: vi.fn(),
    tx: vi.fn(() => ({ onceSealed: () => self.onceSealed() })),
    arg: vi.fn((value: unknown, type: unknown) => ({ value, type })),
    t: { Address: "Address", UInt64: "UInt64", Array: (x: string) => `Array(${x})` },
    currentUser: { snapshot: vi.fn(), authorization: vi.fn() },
  }
  return self
})
vi.mock("@onflow/fcl", () => fcl)
vi.mock("@/lib/chains/flow/flow", () => ({ initFcl: vi.fn() }))

import { coSign, readComposite, relayedAuthorizer, sendSwap, type RelayIO } from "@/lib/swap-test/swap-wallet"
import { SWAP_CADENCE, SWAP_GAS_LIMIT } from "@/lib/swap-test/swap-cadence"
import type { SwapPlan } from "@/lib/swap-test/plan"

const SIG = "cd".repeat(64)
const plan: SwapPlan = {
  a: { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac", ids: ["27289790"], kind: "linked", ctl: "87" },
  b: { signer: "0xd96dc67ae64ee202", source: "0xd96dc67ae64ee202", ids: [], kind: "own", ctl: "0" },
}
const io = (): RelayIO & { post: ReturnType<typeof vi.fn> } => ({
  post: vi.fn(async () => "relay-1"),
  waitForSignature: vi.fn(async () => ({ signature: SIG, keyId: 3 })),
  onRelay: vi.fn(),
})

beforeEach(() => vi.clearAllMocks())

describe("swap-test/swap-wallet — one wallet per tab", () => {
  it("keeps FCL's session in sessionStorage in the browser, so a co-signer tab can't overwrite the initiator's", async () => {
    vi.resetModules()
    const put = vi.fn()
    fcl.config.mockReturnValue({ put, delete: vi.fn() })
    ;(fcl as Record<string, unknown>).SESSION_STORAGE = "SESSION"
    vi.stubGlobal("window", {})
    try {
      await import("@/lib/swap-test/swap-wallet")
      expect(put).toHaveBeenCalledWith("fcl.storage", "SESSION")
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("swap-test/swap-wallet — initiator", () => {
  it("sends SWAP_CADENCE with the plan's arguments in order, wallet A first, and waits for the seal", async () => {
    fcl.currentUser.snapshot.mockResolvedValue({ addr: "0x3d0b274c80263484" })
    fcl.mutate.mockResolvedValue("tx1")
    fcl.onceSealed.mockResolvedValue({ statusCode: 0 })
    await expect(sendSwap(plan, io())).resolves.toEqual({ txId: "tx1" })
    const opts = fcl.mutate.mock.calls[0][0]
    expect(opts.cadence).toBe(SWAP_CADENCE)
    expect(opts.limit).toBe(SWAP_GAS_LIMIT)
    expect(opts.args(fcl.arg, fcl.t)).toEqual([
      { value: "0xbd94cade097e50ac", type: "Address" },
      { value: "87", type: "UInt64" },
      { value: ["27289790"], type: "Array(UInt64)" },
      { value: "0xd96dc67ae64ee202", type: "Address" },
      { value: "0", type: "UInt64" },
      { value: [], type: "Array(UInt64)" },
    ])
    expect(opts.authorizations).toHaveLength(2)
    expect(opts.authorizations[0]).toBe(fcl.currentUser.authorization)
  })

  it("refuses to start from the wrong wallet", async () => {
    fcl.currentUser.snapshot.mockResolvedValue({ addr: "0xd96dc67ae64ee202" })
    await expect(sendSwap(plan, io())).rejects.toThrow("side A")
    expect(fcl.mutate).not.toHaveBeenCalled()
  })

  it("a transaction that seals with an error is a failure", async () => {
    fcl.currentUser.snapshot.mockResolvedValue({ addr: "0x3d0b274c80263484" })
    fcl.mutate.mockResolvedValue("tx2")
    fcl.onceSealed.mockResolvedValue({ statusCode: 1, errorMessage: "panic: Cannot withdraw: Moment is locked" })
    await expect(sendSwap(plan, io())).rejects.toThrow("Moment is locked")
  })

  it("wallet B's signature comes through the relay and carries the key that signed", async () => {
    const r = io()
    const acct = await relayedAuthorizer("0xD96DC67AE64EE202", r)({ role: { authorizer: true } })
    expect(acct.addr).toBe("d96dc67ae64ee202")
    const interaction = { accounts: { x: { addr: "d96dc67ae64ee202", keyId: 0, role: { authorizer: true } }, y: { addr: "3d0b274c80263484", keyId: 0, role: { authorizer: true } } } }
    const out = await acct.signingFunction({ message: "aa", interaction, voucher: {}, fn: () => 1 })
    expect(out).toEqual({ addr: "d96dc67ae64ee202", keyId: 3, signature: SIG })
    expect(r.post).toHaveBeenCalledWith("0xd96dc67ae64ee202", expect.not.objectContaining({ fn: expect.anything() }))
    expect(r.onRelay).toHaveBeenCalledWith("relay-1")
    expect(interaction.accounts.x.keyId).toBe(3)
    // wallet A's entry is untouched
    expect(interaction.accounts.y.keyId).toBe(0)
  })
})

describe("swap-test/swap-wallet — co-signer", () => {
  const signable = { cadence: SWAP_CADENCE, message: "aa", args: [], interaction: {}, voucher: {} }

  it("refuses to sign anything that is not the swap transaction", async () => {
    await expect(coSign({ ...signable, cadence: "transaction {}" }, "0xd96dc67ae64ee202")).rejects.toThrow("refusing to sign")
    expect(fcl.currentUser.authorization).not.toHaveBeenCalled()
  })

  it("refuses from the wrong wallet", async () => {
    fcl.currentUser.snapshot.mockResolvedValue({ addr: "0x3d0b274c80263484" })
    await expect(coSign(signable, "0xd96dc67ae64ee202")).rejects.toThrow("side B")
  })

  it("signs as the AUTHORIZER the wallet's pre-authz names, ignoring a sponsor payer", async () => {
    fcl.currentUser.snapshot.mockResolvedValue({ addr: "0xd96dc67ae64ee202" })
    const payerSign = vi.fn()
    const mineSign = vi.fn(async () => ({ f_type: "CompositeSignature", addr: "d96dc67ae64ee202", keyId: 1, signature: SIG }))
    const resolve = vi.fn(async () => [
      { addr: "0xfeedfeedfeedfeed", keyId: 9, role: { payer: true }, signingFunction: payerSign },
      { addr: "d96dc67ae64ee202", keyId: 1, role: { authorizer: true }, signingFunction: mineSign },
    ])
    fcl.currentUser.authorization.mockResolvedValue({ tempId: "CURRENT_USER", resolve })
    await expect(coSign(signable, "0xd96dc67ae64ee202")).resolves.toEqual({ signature: SIG, keyId: 1 })
    expect(payerSign).not.toHaveBeenCalled()
    expect(mineSign).toHaveBeenCalledWith(expect.objectContaining({ addr: "d96dc67ae64ee202", keyId: 1, message: "aa" }))
  })

  it("reads a composite signature in either shape, and refuses an empty one", () => {
    expect(readComposite({ signature: SIG, keyId: 2 }, 0)).toEqual({ signature: SIG, keyId: 2 })
    expect(readComposite({ data: { signature: `0x${SIG}` } }, 4)).toEqual({ signature: SIG, keyId: 4 })
    expect(() => readComposite({}, 0)).toThrow("no signature")
  })
})
