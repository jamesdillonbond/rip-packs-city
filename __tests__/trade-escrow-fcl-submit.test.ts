import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Server-side RPCTradeEscrow submitters. FCL + the hot-wallet authz are mocked,
// so these tests pin what we BUILD and SUBMIT (cadence + typed args + the
// {tx_id, sealed} contract + the ensureLive gate + sealed-with-error handling),
// not on-chain behavior — the contract is undeployed and UNVERIFIED.

interface MutateOpts {
  cadence: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: (arg: any) => any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}
const calls: MutateOpts[] = []
const state = {
  mutateThrows: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sealResult: { status: 4, events: [] as any[] } as any,
}

vi.mock("@onflow/fcl", () => ({
  mutate: async (opts: MutateOpts) => {
    calls.push(opts)
    if (state.mutateThrows) throw new Error("mutate rejected")
    return "0x" + "a".repeat(64)
  },
  tx: () => ({ onceSealed: async () => state.sealResult }),
}))
vi.mock("@onflow/types", () => ({
  Address: "Address",
  String: "String",
  UInt64: "UInt64",
  UFix64: "UFix64",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Array: (inner: any) => ({ array: inner }),
}))
vi.mock("@/lib/breaks/server-authz", () => ({
  configureFcl: () => {},
  buildHotWalletAuthz: () => ({ addr: "0x3aa11c84d776838f" }),
}))

import {
  submitProposeTrade,
  submitDepositToTrade,
  submitExecuteSwap,
  submitCancelTrade,
  submitReclaimExpired,
} from "@/lib/trade-escrow/fcl-submit"

// A recording `arg` so we can materialize the args resolver into {value,type}.
function resolveArgs(opts: MutateOpts): { value: unknown; type: unknown }[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rec = (value: any, type: any) => ({ value, type })
  return opts.args(rec)
}
function last(): MutateOpts {
  return calls[calls.length - 1]
}

let savedAddr: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  calls.length = 0
  state.mutateThrows = false
  state.sealResult = { status: 4, events: [] }
  savedAddr = process.env.RPC_TRADE_ESCROW_ADDRESS
  process.env.RPC_TRADE_ESCROW_ADDRESS = "0xdeadbeef00000000"
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  if (savedAddr === undefined) delete process.env.RPC_TRADE_ESCROW_ADDRESS
  else process.env.RPC_TRADE_ESCROW_ADDRESS = savedAddr
  logSpy.mockRestore()
})

describe("ensureLive gate", () => {
  it("every submitter throws when RPC_TRADE_ESCROW_ADDRESS is unset", async () => {
    delete process.env.RPC_TRADE_ESCROW_ADDRESS
    await expect(submitProposeTrade({} as never)).rejects.toThrow(/not deployed \(propose\)/)
    await expect(submitDepositToTrade({} as never)).rejects.toThrow(/not deployed \(deposit\)/)
    await expect(submitExecuteSwap({} as never)).rejects.toThrow(/not deployed \(execute\)/)
    await expect(submitCancelTrade({} as never)).rejects.toThrow(/not deployed \(cancel\)/)
    await expect(submitReclaimExpired({} as never)).rejects.toThrow(/not deployed \(reclaim\)/)
    expect(calls.length).toBe(0)
  })

  it("the sentinel '<unset>' value is also treated as unset", async () => {
    process.env.RPC_TRADE_ESCROW_ADDRESS = "<unset>"
    await expect(submitExecuteSwap({ chain_trade_id: "1" })).rejects.toThrow(/not deployed/)
  })
})

describe("submitProposeTrade", () => {
  it("submits the propose cadence with typed args (UFix64 gets a decimal) and returns sealed", async () => {
    const res = await submitProposeTrade({
      partyA: "0xaaaa",
      partyB: "0xbbbb",
      partyA_nft_type: "A.0b2a3299cc857e29.TopShot.NFT",
      partyB_nft_type: "A.e4cf4bdc1751c65d.AllDay.NFT",
      partyA_expected_ids: ["1"],
      partyB_expected_ids: ["2", "3"],
      expires_at_unix_sec: "1712345678",
    })
    expect(res).toEqual({ tx_id: "0x" + "a".repeat(64), sealed: true })
    const opts = last()
    expect(opts.cadence).toContain("RPCTradeEscrow.proposeTrade(")
    expect(opts.cadence).toContain("import RPCTradeEscrow from 0xdeadbeef00000000")
    const args = resolveArgs(opts)
    expect(args[0]).toEqual({ value: "0xaaaa", type: "Address" })
    expect(args[2]).toEqual({ value: "A.0b2a3299cc857e29.TopShot.NFT", type: "String" })
    expect(args[4]).toEqual({ value: ["1"], type: { array: "UInt64" } })
    // UFix64 must carry a decimal point
    expect(args[6]).toEqual({ value: "1712345678.0", type: "UFix64" })
  })

  it("logs the TradeProposed tradeId when the sealed events carry one", async () => {
    state.sealResult = {
      status: 4,
      events: [{ type: "A.deadbeef.RPCTradeEscrow.TradeProposed", data: { tradeId: "17" } }],
    }
    await submitProposeTrade({
      partyA: "0xaaaa",
      partyB: "0xbbbb",
      partyA_nft_type: "x",
      partyB_nft_type: "y",
      partyA_expected_ids: ["1"],
      partyB_expected_ids: [],
      expires_at_unix_sec: "1712345678",
    })
    expect(JSON.stringify(logSpy.mock.calls)).toContain("tradeId 17")
  })

  it("rejects a non-integer expiry", async () => {
    await expect(
      submitProposeTrade({
        partyA: "0xaaaa",
        partyB: "0xbbbb",
        partyA_nft_type: "x",
        partyB_nft_type: "y",
        partyA_expected_ids: [],
        partyB_expected_ids: ["2"],
        expires_at_unix_sec: "17.5",
      })
    ).rejects.toThrow(/integer string/)
  })

  it("throws when the tx seals with an error", async () => {
    state.sealResult = { status: 4, errorMessage: "assertion failed: Expiry too short", events: [] }
    await expect(
      submitProposeTrade({
        partyA: "0xaaaa",
        partyB: "0xbbbb",
        partyA_nft_type: "x",
        partyB_nft_type: "y",
        partyA_expected_ids: ["1"],
        partyB_expected_ids: [],
        expires_at_unix_sec: "1712345678",
      })
    ).rejects.toThrow(/reverted: assertion failed/)
  })
})

describe("submitDepositToTrade", () => {
  it("uses the collection's paths and passes tradeId + nftIds", async () => {
    const res = await submitDepositToTrade({
      chain_trade_id: "7",
      depositor: "0xaaaa",
      side: "A",
      nft_ids: ["11", "12"],
      collection: "topshot",
      incoming_collection: "allday",
    })
    expect(res.sealed).toBe(true)
    const opts = last()
    expect(opts.cadence).toContain("from: /storage/MomentCollection")
    expect(opts.cadence).toContain("/public/AllDayNFTCollection")
    const args = resolveArgs(opts)
    expect(args[0]).toEqual({ value: "7", type: "UInt64" })
    expect(args[1]).toEqual({ value: ["11", "12"], type: { array: "UInt64" } })
  })
})

describe("execute / cancel / reclaim", () => {
  it("execute submits just the tradeId", async () => {
    await submitExecuteSwap({ chain_trade_id: "9" })
    const args = resolveArgs(last())
    expect(args).toEqual([{ value: "9", type: "UInt64" }])
    expect(last().cadence).toContain("RPCTradeEscrow.executeSwap")
  })

  it("cancel submits tradeId + reason", async () => {
    await submitCancelTrade({ chain_trade_id: "9", cancelled_by: "0xaaaa", reason: "changed mind" })
    const args = resolveArgs(last())
    expect(args[0]).toEqual({ value: "9", type: "UInt64" })
    expect(args[1]).toEqual({ value: "changed mind", type: "String" })
  })

  it("reclaim submits just the tradeId", async () => {
    await submitReclaimExpired({ chain_trade_id: "9" })
    expect(last().cadence).toContain("RPCTradeEscrow.reclaimExpired")
  })

  it("propagates a mutate broadcast failure", async () => {
    state.mutateThrows = true
    await expect(submitExecuteSwap({ chain_trade_id: "9" })).rejects.toThrow(/mutate rejected/)
  })

  it("logs the contract address from the env var", async () => {
    await submitExecuteSwap({ chain_trade_id: "9" })
    expect(JSON.stringify(logSpy.mock.calls)).toContain("contract=0xdeadbeef00000000")
  })
})
