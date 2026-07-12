import { describe, it, expect } from "vitest"
import { walletBackfillLockKey } from "@/lib/wallet-backfill-lock"

// lib/wallet-backfill-lock.ts — only walletBackfillLockKey is pure; claim/release
// hit Supabase RPCs and are out of scope. The key is per-(collection, wallet)
// with the wallet lowercased so different collections for the same wallet never
// collide and case variants of a wallet map to one lock.

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
