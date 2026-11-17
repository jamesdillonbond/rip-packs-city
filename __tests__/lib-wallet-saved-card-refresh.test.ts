// 2026-11-07: a new collector's NBA card sat at the 50-row first-paint count while
// the cache held 880 — the walkers refreshed seeded_wallets stats on completion,
// never the saved cards. refreshSavedCardsForWallet closes that; these pin it.
import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { refreshSavedCardsForWallet } from "@/lib/wallet/saved-card-refresh"

function db(rows: { user_id: string | null }[], opts: { readError?: string; rpcError?: string } = {}) {
  const eq = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(opts.readError ? { data: null, error: { message: opts.readError } } : { data: rows, error: null }),
  })
  const rpc = vi.fn().mockResolvedValue(opts.rpcError ? { error: { message: opts.rpcError } } : { data: 1, error: null })
  return { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) }), rpc, eq }
}

describe("refreshSavedCardsForWallet", () => {
  it("re-aggregates once per OWNER of the wallet (rows are per collection)", async () => {
    const d = db([{ user_id: "u1" }, { user_id: "u1" }, { user_id: "u2" }, { user_id: null }])
    const out = await refreshSavedCardsForWallet("0x4ea719c9a4febb47", 830, d)
    expect(d.eq).toHaveBeenCalledWith("wallet_addr", "0x4ea719c9a4febb47")
    expect(d.rpc).toHaveBeenCalledTimes(2)
    expect(d.rpc).toHaveBeenCalledWith("aggregate_saved_wallet_stats", { p_user_id: "u1", p_wallet_addr: "0x4ea719c9a4febb47" })
    expect(out).toEqual({ owners: 2, refreshed: 2, error: null })
  })
  it("a walk that changed nothing touches nothing", async () => {
    const d = db([{ user_id: "u1" }])
    expect(await refreshSavedCardsForWallet("0xabc", 0, d)).toEqual({ owners: 0, refreshed: 0, error: null })
    expect(d.from).not.toHaveBeenCalled()
  })
  it("an UNKNOWN change count still refreshes", async () => {
    const d = db([{ user_id: "u1" }])
    expect((await refreshSavedCardsForWallet("0xabc", undefined, d)).refreshed).toBe(1)
  })
  it("a wallet nobody saved costs one read and no aggregate", async () => {
    const d = db([])
    expect(await refreshSavedCardsForWallet("0xabc", 5, d)).toEqual({ owners: 0, refreshed: 0, error: null })
    expect(d.rpc).not.toHaveBeenCalled()
  })
  it("failures are reported, never thrown, and never counted as refreshed", async () => {
    expect((await refreshSavedCardsForWallet("0xabc", 5, db([], { readError: "boom" }))).error).toBe("boom")
    const out = await refreshSavedCardsForWallet("0xabc", 5, db([{ user_id: "u1" }], { rpcError: "timeout" }))
    expect(out).toEqual({ owners: 1, refreshed: 0, error: "timeout" })
  })
  it("both walkers' stampLastRefreshed call it", () => {
    for (const f of ["app/api/wallet-backfill/route.ts", "lib/chains/flow/wallet-backfill-helpers.ts"]) {
      const src = readFileSync(f, "utf8")
      const body = src.slice(src.indexOf("async function stampLastRefreshed("), src.indexOf("async function stampLastRefreshed(") + 600)
      expect(body, f).toContain("await refreshSavedCardsForWallet(wallet, changedRows)")
    }
  })
})
