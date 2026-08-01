import { describe, it, expect } from "vitest"
import {
  sumMoments,
  sumFmv,
  sumStaleFmv,
  sumStaleCount,
  countActiveCollections,
  groupWalletsByAddress,
  type StatsByWallet,
} from "@/lib/dashboard/aggregate"

const statsByWallet: StatsByWallet = {
  "0xaaa": [
    { collection_id: "ts", moment_count: 10, fmv_total: 100, fmv_stale_total: 5, stale_count: 2 },
    { collection_id: "ad", moment_count: 0, fmv_total: 0, fmv_stale_total: 0, stale_count: 0 },
  ],
  "0xbbb": [
    { collection_id: "ts", moment_count: 3, fmv_total: 40.5, fmv_stale_total: 1.5, stale_count: 1 },
    { collection_id: "gz", moment_count: 7, fmv_total: 60, fmv_stale_total: 0, stale_count: 0 },
  ],
}

describe("dashboard aggregate — sums", () => {
  it("sumMoments totals moment_count across all wallets/collections", () => {
    expect(sumMoments(statsByWallet)).toBe(20)
  })
  it("sumFmv totals fmv_total", () => {
    expect(sumFmv(statsByWallet)).toBe(200.5)
  })
  it("sumStaleFmv totals the stale FMV footnote", () => {
    expect(sumStaleFmv(statsByWallet)).toBe(6.5)
  })
  it("sumStaleCount totals stale_count", () => {
    expect(sumStaleCount(statsByWallet)).toBe(3)
  })
  it("treats missing numeric fields as 0 (null-safe)", () => {
    const sparse: StatsByWallet = { "0xz": [{ collection_id: "ts" }, { collection_id: null, moment_count: null }] }
    expect(sumMoments(sparse)).toBe(0)
    expect(sumFmv(sparse)).toBe(0)
    expect(sumStaleFmv(sparse)).toBe(0)
    expect(sumStaleCount(sparse)).toBe(0)
  })
  it("empty map sums to 0", () => {
    expect(sumMoments({})).toBe(0)
    expect(countActiveCollections({})).toBe(0)
  })
})

describe("dashboard aggregate — countActiveCollections", () => {
  it("counts distinct collection_ids with moment_count > 0 (dedupes across wallets)", () => {
    // ts appears in both wallets (held), gz held, ad has 0 moments -> excluded.
    expect(countActiveCollections(statsByWallet)).toBe(2)
  })
  it("excludes rows with 0 moments and null collection_id", () => {
    const s: StatsByWallet = {
      "0x1": [
        { collection_id: "a", moment_count: 0 },
        { collection_id: null, moment_count: 5 },
        { collection_id: "b", moment_count: 1 },
      ],
    }
    expect(countActiveCollections(s)).toBe(1)
  })
})

describe("dashboard aggregate — groupWalletsByAddress", () => {
  it("groups rows by lowercased address, one entry per physical wallet", () => {
    const groups = groupWalletsByAddress([
      { wallet_addr: "0xABC", nickname: null, verified_at: null },
      { wallet_addr: "0xabc", nickname: "main", verified_at: "2026-01-01" },
      { wallet_addr: "0xdef", nickname: "alt", verified_at: null },
    ])
    expect(groups).toHaveLength(2)
    const abc = groups.find((g) => g.addr === "0xABC")!
    expect(abc.rows).toHaveLength(2)
    // First non-empty nickname / verified_at wins.
    expect(abc.nickname).toBe("main")
    expect(abc.verifiedAt).toBe("2026-01-01")
  })
  it("preserves the first-seen address casing and keeps the first nickname when it is already set", () => {
    const groups = groupWalletsByAddress([
      { wallet_addr: "0xAaA", nickname: "first", verified_at: "2026-02-02" },
      { wallet_addr: "0xaaa", nickname: "second", verified_at: "2026-03-03" },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].addr).toBe("0xAaA")
    expect(groups[0].nickname).toBe("first")
    expect(groups[0].verifiedAt).toBe("2026-02-02")
  })
  it("handles an empty list", () => {
    expect(groupWalletsByAddress([])).toEqual([])
  })
})
