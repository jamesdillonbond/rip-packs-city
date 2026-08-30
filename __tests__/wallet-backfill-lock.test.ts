import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// lib/wallet-backfill-lock.ts — the claim/release concurrency guard around the
// wallet-backfill writers. walletBackfillLockKey is pure; claim/release wrap the
// claim_pipeline_lock / release_pipeline_lock RPCs and are FAIL-OPEN by design.
// This file mocks the supabase seam to pin: the key shape, claim true/false,
// the optional p_stale_seconds arg, and every fail-open branch (RPC error object
// and thrown RPC → claim returns true; release swallows throws).

const { state, rpcMock } = vi.hoisted(() => {
  const state: { claim: any; claimThrow: boolean | "raw"; releaseThrow: boolean | "raw" } = {
    claim: { data: true, error: null },
    claimThrow: false,
    releaseThrow: false,
  }
  const rpcMock = vi.fn(async (name: string) => {
    if (name === "claim_pipeline_lock") {
      if (state.claimThrow === "raw") throw "claim string"
      if (state.claimThrow) throw new Error("claim boom")
      return state.claim
    }
    if (name === "release_pipeline_lock") {
      if (state.releaseThrow === "raw") throw "release string"
      if (state.releaseThrow) throw new Error("release boom")
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
  return { state, rpcMock }
})

vi.mock("@/lib/supabase", () => {
  const client: any = { rpc: rpcMock }
  return { supabase: client, supabaseAdmin: client }
})

import {
  walletBackfillLockKey,
  claimPipelineLock,
  claimPipelineLockDetailed,
  isDbSaturationError,
  releasePipelineLock,
  skippedReasonFor,
} from "@/lib/wallet-backfill-lock"

let warnSpy: any
beforeEach(() => {
  state.claim = { data: true, error: null }
  state.claimThrow = false
  state.releaseThrow = false
  rpcMock.mockClear()
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
})

describe("walletBackfillLockKey", () => {
  it("builds a wallet-backfill:<slug>:<wallet> key", () => {
    expect(walletBackfillLockKey("nba_top_shot", "0xABC123")).toBe(
      "wallet-backfill:nba_top_shot:0xabc123",
    )
  })

  it("lowercases the wallet but leaves the collection slug untouched", () => {
    expect(walletBackfillLockKey("NFL_All_Day", "0xDEADBEEF")).toBe(
      "wallet-backfill:NFL_All_Day:0xdeadbeef",
    )
  })

  it("produces identical keys for differently-cased wallets", () => {
    expect(walletBackfillLockKey("disney_pinnacle", "0xAbCd")).toBe(
      walletBackfillLockKey("disney_pinnacle", "0xabcd"),
    )
  })
})

describe("claimPipelineLock", () => {
  it("returns true and calls the RPC with just p_key when the lock is acquired", async () => {
    state.claim = { data: true, error: null }
    const ok = await claimPipelineLock("k1")
    expect(ok).toBe(true)
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock.mock.calls[0][0]).toBe("claim_pipeline_lock")
    expect((rpcMock.mock.calls[0] as any[])[1]).toEqual({ p_key: "k1" })
  })

  it("passes p_stale_seconds through when provided", async () => {
    await claimPipelineLock("k1", 90)
    expect((rpcMock.mock.calls[0] as any[])[1]).toEqual({ p_key: "k1", p_stale_seconds: 90 })
  })

  it("returns false when a concurrent claim already holds the lock", async () => {
    state.claim = { data: false, error: null }
    expect(await claimPipelineLock("k1")).toBe(false)
  })

  it("returns false for any non-true data (e.g. null)", async () => {
    state.claim = { data: null, error: null }
    expect(await claimPipelineLock("k1")).toBe(false)
  })

  it("fails open (returns true) when the RPC returns an error object", async () => {
    state.claim = { data: null, error: { message: "lock table missing" } }
    expect(await claimPipelineLock("k1")).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
  })

  it("fails open (returns true) when the RPC throws", async () => {
    state.claimThrow = true
    expect(await claimPipelineLock("k1")).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
  })

  it("fails open when the RPC throws a non-Error value", async () => {
    state.claimThrow = "raw"
    expect(await claimPipelineLock("k1")).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
  })
})

// 2026-08-30 carve-out: a claim that fails because the DATABASE HAS NO
// CAPACITY fails CLOSED. Measured over 24 h: 656 claim errors of exactly these
// shapes, all proceeding, and 226 overlapping same-wallet walks on the table the
// pool was saturated writing to. Everything else keeps the original fail-open.
describe("claimPipelineLock — saturated-database carve-out", () => {
  const SATURATION_MESSAGES = [
    "Timed out acquiring connection from connection pool.",
    "Could not query the database for the schema cache. Retrying.",
    "canceling statement due to lock timeout",
    "canceling statement due to statement timeout",
  ]

  it.each(SATURATION_MESSAGES)("fails CLOSED on an RPC error object saying %s", async (message) => {
    state.claim = { data: null, error: { message } }
    expect(await claimPipelineLock("k1")).toBe(false)
    expect(await claimPipelineLockDetailed("k1")).toEqual({ claimed: false, reason: "db_saturated" })
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls.at(-1)?.[0])).toContain("fail-closed")
  })

  it("fails CLOSED when the RPC THROWS a saturation-class error", async () => {
    state.claimThrow = true
    rpcMock.mockImplementationOnce(async () => {
      throw new Error("Timed out acquiring connection from connection pool.")
    })
    expect(await claimPipelineLockDetailed("k1")).toEqual({ claimed: false, reason: "db_saturated" })
  })

  it("still fails OPEN on an error that means the lock table itself is broken", async () => {
    state.claim = { data: null, error: { message: "function claim_pipeline_lock(p_key => text) does not exist" } }
    expect(await claimPipelineLockDetailed("k1")).toEqual({ claimed: true, reason: "fail_open" })
    state.claim = { data: null, error: { message: "permission denied for table pipeline_run_locks" } }
    expect(await claimPipelineLock("k1")).toBe(true)
  })

  it("reports the plain outcomes with their own reasons", async () => {
    state.claim = { data: true, error: null }
    expect(await claimPipelineLockDetailed("k1")).toEqual({ claimed: true, reason: "claimed" })
    state.claim = { data: false, error: null }
    expect(await claimPipelineLockDetailed("k1")).toEqual({ claimed: false, reason: "in_progress" })
  })

  it("maps a refused claim to the terminated_reason the runners record", () => {
    expect(skippedReasonFor({ claimed: false, reason: "in_progress" })).toBe("skipped_in_progress")
    expect(skippedReasonFor({ claimed: false, reason: "db_saturated" })).toBe("skipped_db_saturated")
  })

  it("isDbSaturationError is a narrow allow-list, not a catch-all", () => {
    for (const m of SATURATION_MESSAGES) expect(isDbSaturationError(m)).toBe(true)
    expect(isDbSaturationError("lock table missing")).toBe(false)
    expect(isDbSaturationError("")).toBe(false)
    expect(isDbSaturationError("relation pipeline_run_locks does not exist")).toBe(false)
  })
})

describe("releasePipelineLock", () => {
  it("calls release_pipeline_lock with p_key", async () => {
    await releasePipelineLock("k9")
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock.mock.calls[0][0]).toBe("release_pipeline_lock")
    expect((rpcMock.mock.calls[0] as any[])[1]).toEqual({ p_key: "k9" })
  })

  it("swallows a thrown release without rejecting", async () => {
    state.releaseThrow = true
    await expect(releasePipelineLock("k9")).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  it("swallows a non-Error thrown release", async () => {
    state.releaseThrow = "raw"
    await expect(releasePipelineLock("k9")).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })
})
