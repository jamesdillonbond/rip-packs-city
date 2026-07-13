import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins lib/trade-escrow/fcl-submit.ts — the shelved Trade Hub backend submitters.
// Trade escrow is NOT deployed, so every exported submitter must hard-fail via
// ensureLive() when RPC_TRADE_ESCROW_ADDRESS is unset (the primary current
// behavior). With the env set, the stub build path runs to completion: it
// returns a `0xstub_<verb>_...` tx id (sealed:false) and, for deposit, resolves
// the per-collection template/paths from COLLECTION_META. Env is saved/restored
// so the guard branch and the live-mode branch are both exercised deterministically.

import {
  submitProposeTrade,
  submitDepositToTrade,
  submitExecuteSwap,
  submitCancelTrade,
  submitReclaimExpired,
} from "@/lib/trade-escrow/fcl-submit"
import type {
  ProposeTradeArgs,
  DepositToTradeArgs,
  ExecuteSwapArgs,
  CancelTradeArgs,
  ReclaimExpiredArgs,
} from "@/lib/trade-escrow/types"

const proposeArgs: ProposeTradeArgs = {
  partyA: "0xaaaa",
  partyB: "0xbbbb",
  partyA_nft_type: "A.0b2a3299cc857e29.TopShot.NFT",
  partyB_nft_type: "A.e4cf4bdc1751c65d.AllDay.NFT",
  partyA_expected_ids: ["1", "2"],
  partyB_expected_ids: ["3"],
  expires_at_unix_sec: "1893456000",
}
const depositArgs: DepositToTradeArgs = {
  chain_trade_id: "42",
  depositor: "0xaaaa",
  side: "A",
  nft_ids: ["1", "2"],
  collection: "topshot",
  incoming_collection: "allday",
}
const executeArgs: ExecuteSwapArgs = { chain_trade_id: "42" }
const cancelArgs: CancelTradeArgs = { chain_trade_id: "42", cancelled_by: "0xaaaa", reason: "changed mind" }
const reclaimArgs: ReclaimExpiredArgs = { chain_trade_id: "42" }

let savedAddr: string | undefined
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  savedAddr = process.env.RPC_TRADE_ESCROW_ADDRESS
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  if (savedAddr === undefined) delete process.env.RPC_TRADE_ESCROW_ADDRESS
  else process.env.RPC_TRADE_ESCROW_ADDRESS = savedAddr
  logSpy.mockRestore()
})

describe("ensureLive guard — env unset (shelved state)", () => {
  beforeEach(() => {
    delete process.env.RPC_TRADE_ESCROW_ADDRESS
  })

  it("submitProposeTrade rejects with the not-deployed error", async () => {
    await expect(submitProposeTrade(proposeArgs)).rejects.toThrow(
      /Trade escrow unavailable: RPCTradeEscrow contract not deployed \(propose\)/
    )
  })
  it("submitDepositToTrade rejects", async () => {
    await expect(submitDepositToTrade(depositArgs)).rejects.toThrow(/not deployed \(deposit\)/)
  })
  it("submitExecuteSwap rejects", async () => {
    await expect(submitExecuteSwap(executeArgs)).rejects.toThrow(/not deployed \(execute\)/)
  })
  it("submitCancelTrade rejects", async () => {
    await expect(submitCancelTrade(cancelArgs)).rejects.toThrow(/not deployed \(cancel\)/)
  })
  it("submitReclaimExpired rejects", async () => {
    await expect(submitReclaimExpired(reclaimArgs)).rejects.toThrow(/not deployed \(reclaim\)/)
  })

  it("the sentinel '<unset>' value is also treated as unset", async () => {
    process.env.RPC_TRADE_ESCROW_ADDRESS = "<unset>"
    await expect(submitProposeTrade(proposeArgs)).rejects.toThrow(/not deployed/)
  })
})

describe("live mode — env set, stub build path", () => {
  beforeEach(() => {
    process.env.RPC_TRADE_ESCROW_ADDRESS = "0x1234567890abcdef"
  })

  it("submitProposeTrade returns an unsealed 0xstub_propose_ tx", async () => {
    const res = await submitProposeTrade(proposeArgs)
    expect(res.sealed).toBe(false)
    expect(res.tx_id).toMatch(/^0xstub_propose_[a-z0-9]+$/)
    expect(logSpy).toHaveBeenCalled()
  })

  it("submitDepositToTrade returns 0xstub_deposit_ and logs the resolved template/paths", async () => {
    const res = await submitDepositToTrade(depositArgs)
    expect(res).toEqual({ tx_id: expect.stringMatching(/^0xstub_deposit_[a-z0-9]+$/), sealed: false })
    // logCall payload carries the per-collection template + storage/public paths.
    const logged = JSON.stringify(logSpy.mock.calls)
    expect(logged).toContain("deposit_to_trade_topshot.cdc")
    expect(logged).toContain("/storage/MomentCollection") // topshot storage_path
    expect(logged).toContain("/public/AllDayNFTCollection") // incoming (allday) public_path
  })

  it("submitExecuteSwap returns 0xstub_execute_", async () => {
    const res = await submitExecuteSwap(executeArgs)
    expect(res.tx_id).toMatch(/^0xstub_execute_/)
    expect(res.sealed).toBe(false)
  })

  it("submitCancelTrade returns 0xstub_cancel_", async () => {
    const res = await submitCancelTrade(cancelArgs)
    expect(res.tx_id).toMatch(/^0xstub_cancel_/)
  })

  it("submitReclaimExpired returns 0xstub_reclaim_", async () => {
    const res = await submitReclaimExpired(reclaimArgs)
    expect(res.tx_id).toMatch(/^0xstub_reclaim_/)
  })

  it("tx ids are unique across calls (random suffix)", async () => {
    const a = await submitProposeTrade(proposeArgs)
    const b = await submitProposeTrade(proposeArgs)
    expect(a.tx_id).not.toBe(b.tx_id)
  })

  it("the logged contract address reflects the set env var", async () => {
    await submitExecuteSwap(executeArgs)
    const logged = JSON.stringify(logSpy.mock.calls)
    expect(logged).toContain("contract=0x1234567890abcdef")
  })
})
