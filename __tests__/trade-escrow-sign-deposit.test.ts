import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// lib/trade-escrow/sign-deposit.ts — client-side deposit signature. FCL is
// mocked (the user's wallet signs on the client); this pins that it builds the
// deposit cadence, signs+seals via fcl.mutate, then POSTs the resulting tx id
// to /api/trade-chain/deposit-callback, plus the not-configured / revert /
// server-failure / network-error branches. UNVERIFIED (contract undeployed).

const state = {
  txId: "0x" + "d".repeat(64),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Array: (inner: any) => ({ array: inner }),
}))

import { signAndSubmitDeposit, type SignDepositArgs } from "@/lib/trade-escrow/sign-deposit"

const fetchMock = vi.fn()
const baseArgs: SignDepositArgs = {
  trade_match_id: "match-1",
  chain_trade_id: 42,
  side: "A",
  depositor_address: "0xaaaa",
  collection: "topshot",
  incoming_collection: "allday",
  nft_ids: ["1", "2"],
}

let savedAddr: string | undefined

beforeEach(() => {
  state.txId = "0x" + "d".repeat(64)
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

describe("signAndSubmitDeposit — success", () => {
  it("signs the deposit cadence, seals, and reports the real tx id to the callback", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, state: { status: "partial_a" } }) })
    const res = await signAndSubmitDeposit(baseArgs)
    expect(res).toEqual({ ok: true, tx_id: state.txId, state: { status: "partial_a" } })
    // the mutate carried the deposit cadence with the collection's storage path
    expect(lastMutate.cadence).toContain("from: /storage/MomentCollection")
    expect(lastMutate.cadence).toContain("import RPCTradeEscrow from 0xescrow00000000")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/trade-chain/deposit-callback")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ trade_match_id: "match-1", depositor_address: "0xaaaa", side: "A", deposit_tx_id: state.txId })
  })
})

describe("signAndSubmitDeposit — pre-callback failures do NOT post", () => {
  it("returns not-available and never signs when the escrow env is unset", async () => {
    delete process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS
    const res = await signAndSubmitDeposit(baseArgs)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not available/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns the revert reason and does not post when the deposit tx reverts", async () => {
    state.sealResult = { status: 4, errorMessage: "NFT not in expected ids" }
    const res = await signAndSubmitDeposit(baseArgs)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/reverted: NFT not in expected ids/)
    expect(res.tx_id).toBe(state.txId)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns the wallet error when the user rejects the signature", async () => {
    state.mutateThrows = true
    const res = await signAndSubmitDeposit(baseArgs)
    expect(res.ok).toBe(false)
    expect(res.error).toBe("wallet rejected")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("signAndSubmitDeposit — callback failures", () => {
  it("body error → ok:false with that error, real tx id still returned", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: "trade not found" }) })
    const res = await signAndSubmitDeposit(baseArgs)
    expect(res).toMatchObject({ ok: false, error: "trade not found", tx_id: state.txId })
  })

  it("non-ok HTTP with no error body → HTTP <status>", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const res = await signAndSubmitDeposit(baseArgs)
    expect(res.error).toBe("HTTP 503")
  })

  it("fetch rejecting → ok:false with the Error message", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const res = await signAndSubmitDeposit(baseArgs)
    expect(res).toMatchObject({ ok: false, error: "network down" })
  })
})
