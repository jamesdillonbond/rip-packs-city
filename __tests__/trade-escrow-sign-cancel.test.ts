import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// lib/trade-escrow/sign-cancel.ts — client-side cancel signature (mirror of
// sign-deposit.ts). FCL is mocked; pins that it builds the cancel cadence,
// signs+seals via fcl.mutate, then POSTs the tx id to the cancel-callback,
// plus the not-configured / revert / server-failure / network-error branches.
// UNVERIFIED (contract undeployed).

const state = {
  txId: "0x" + "c".repeat(64),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sealResult: { status: 4 } as any,
  mutateThrows: false,
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastMutate: any = null

vi.mock("@onflow/fcl", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutate: async (opts: any) => {
    lastMutate = opts
    if (state.mutateThrows) throw new Error("wallet rejected")
    return state.txId
  },
  tx: () => ({ onceSealed: async () => state.sealResult }),
}))
vi.mock("@onflow/types", () => ({
  UInt64: "UInt64",
  String: "String",
}))

import { signAndSubmitCancel, type SignCancelArgs } from "@/lib/trade-escrow/sign-cancel"

const fetchMock = vi.fn()
const baseArgs: SignCancelArgs = {
  trade_match_id: "match-1",
  chain_trade_id: 42,
  side: "A",
  canceller_address: "0xaaaa",
  reason: "changed my mind",
}

let savedAddr: string | undefined

beforeEach(() => {
  state.txId = "0x" + "c".repeat(64)
  state.sealResult = { status: 4 }
  state.mutateThrows = false
  lastMutate = null
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  savedAddr = process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS
  process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS = "0xescrow00000000"
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (savedAddr === undefined) delete process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS
  else process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS = savedAddr
})

describe("signAndSubmitCancel — success", () => {
  it("signs the cancel cadence, seals, and reports the tx id to the callback", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, state: { status: "cancelled" } }) })
    const res = await signAndSubmitCancel(baseArgs)
    expect(res).toEqual({ ok: true, tx_id: state.txId, state: { status: "cancelled" } })
    expect(lastMutate.cadence).toContain("RPCTradeEscrow.cancelTrade(")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/trade-chain/cancel-callback")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ trade_match_id: "match-1", cancelled_by: "0xaaaa", cancel_tx_id: state.txId, reason: "changed my mind" })
  })

  it("defaults the reason when none is supplied", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = (value: any, type: any) => ({ value, type })
    await signAndSubmitCancel({ ...baseArgs, reason: undefined })
    const args = lastMutate.args(rec)
    expect(args[1]).toEqual({ value: "user_cancelled", type: "String" })
  })
})

describe("signAndSubmitCancel — pre-callback failures do NOT post", () => {
  it("returns not-available and never signs when the escrow env is unset", async () => {
    delete process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS
    const res = await signAndSubmitCancel(baseArgs)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not available/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns the revert reason when the cancel tx reverts", async () => {
    state.sealResult = { status: 4, errorMessage: "Only trade parties can cancel" }
    const res = await signAndSubmitCancel(baseArgs)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/reverted: Only trade parties/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns the wallet error when the user rejects the signature", async () => {
    state.mutateThrows = true
    const res = await signAndSubmitCancel(baseArgs)
    expect(res.ok).toBe(false)
    expect(res.error).toBe("wallet rejected")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("signAndSubmitCancel — callback failures", () => {
  it("body error → ok:false with that error", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: "already executed" }) })
    const res = await signAndSubmitCancel(baseArgs)
    expect(res).toMatchObject({ ok: false, error: "already executed", tx_id: state.txId })
  })

  it("non-ok HTTP with no error body → HTTP <status>", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const res = await signAndSubmitCancel(baseArgs)
    expect(res.error).toBe("HTTP 500")
  })

  it("fetch rejecting → ok:false with the Error message", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const res = await signAndSubmitCancel(baseArgs)
    expect(res).toMatchObject({ ok: false, error: "network down" })
  })
})
