import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import {
  commitmentHash,
  dealIntoPacks,
  manifestOf,
  sealPool,
  shuffle,
  summarizePackValues,
  verifyCommitment,
  PRIZE_VALUE_CAP_USD,
} from "@/lib/giveaways/seal"

describe("giveaways/seal", () => {
  it("shuffle is Fisher–Yates over the injected RNG and never mutates its input", () => {
    const input = ["a", "b", "c", "d"]
    // rand always 0: each step swaps i with 0 → [b, c, d, a]
    expect(shuffle(input, () => 0)).toEqual(["b", "c", "d", "a"])
    // rand = i (the max): identity
    expect(shuffle(input, (max) => max - 1)).toEqual(["a", "b", "c", "d"])
    expect(input).toEqual(["a", "b", "c", "d"])
  })

  it("shuffle with the real CSPRNG is a permutation", () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(i))
    const out = shuffle(ids)
    expect(out.slice().sort()).toEqual(ids.slice().sort())
  })

  it("dealIntoPacks fills packs in order, slots 1..perPack", () => {
    expect(dealIntoPacks(["1", "2", "3", "4", "5", "6"], 3, 2)).toEqual([
      { moment_id: "1", pack_no: 1, slot: 1 },
      { moment_id: "2", pack_no: 1, slot: 2 },
      { moment_id: "3", pack_no: 2, slot: 1 },
      { moment_id: "4", pack_no: 2, slot: 2 },
      { moment_id: "5", pack_no: 3, slot: 1 },
      { moment_id: "6", pack_no: 3, slot: 2 },
    ])
  })

  it("dealIntoPacks refuses a wrong-sized pool, a duplicate, and bad counts", () => {
    expect(() => dealIntoPacks(["1", "2", "3"], 2, 2)).toThrow(/need 4/)
    expect(() => dealIntoPacks(["1", "1", "2", "3"], 2, 2)).toThrow(/duplicate/)
    expect(() => dealIntoPacks([], 0, 2)).toThrow(/packCount/)
    expect(() => dealIntoPacks([], 1, 0)).toThrow(/perPack/)
  })

  it("the manifest format is a public contract: packs ascending, moments in slot order", () => {
    const a = [
      { moment_id: "30", pack_no: 2, slot: 2 },
      { moment_id: "10", pack_no: 1, slot: 1 },
      { moment_id: "40", pack_no: 2, slot: 1 },
      { moment_id: "20", pack_no: 1, slot: 2 },
    ]
    expect(manifestOf(a)).toBe("1:10,20;2:40,30")
  })

  it("the commitment is sha256(salt|manifest) — the command the public page prints", () => {
    const expected = createHash("sha256").update("s|1:10,20;2:40,30").digest("hex")
    expect(commitmentHash("s", "1:10,20;2:40,30")).toBe(expected)
    expect(verifyCommitment("s", "1:10,20;2:40,30", expected.toUpperCase())).toBe(true)
    expect(verifyCommitment("s", "1:10,20;2:30,40", expected)).toBe(false)
  })

  it("sealPool commits to exactly the assignment it returns", () => {
    const r = sealPool(["1", "2", "3", "4"], 2, 2, { salt: "ab", rand: () => 0 })
    expect(r.manifest).toBe(manifestOf(r.assignments))
    expect(r.hash).toBe(commitmentHash("ab", r.manifest))
    expect(r.assignments.map((a) => a.moment_id).sort()).toEqual(["1", "2", "3", "4"])
    // a real salt is 32 random bytes of hex
    const real = sealPool(["1", "2"], 1, 2)
    expect(real.salt).toMatch(/^[0-9a-f]{64}$/)
    expect(real.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("summarizePackValues: mean, median (even count), best", () => {
    const s = summarizePackValues([
      { moment_id: "1", fmv_usd: 1, pack_no: 1 },
      { moment_id: "2", fmv_usd: 2, pack_no: 1 },
      { moment_id: "3", fmv_usd: 10, pack_no: 2 },
      { moment_id: "4", fmv_usd: 0.5, pack_no: 2 },
    ])
    expect(s).toEqual({ pool_fmv_usd: 13.5, unpriced_count: 0, mean_pack_usd: 6.75, median_pack_usd: 6.75, best_pack_usd: 10.5 })
  })

  it("summarizePackValues: median of an odd count is the middle pack", () => {
    const s = summarizePackValues([
      { moment_id: "1", fmv_usd: 1, pack_no: 1 },
      { moment_id: "2", fmv_usd: 5, pack_no: 2 },
      { moment_id: "3", fmv_usd: 9, pack_no: 3 },
    ])
    expect(s.median_pack_usd).toBe(5)
    expect(s.best_pack_usd).toBe(9)
  })

  it("summarizePackValues withholds per-pack values when any moment is unpriced (never a total with a hole)", () => {
    const s = summarizePackValues([
      { moment_id: "1", fmv_usd: 4, pack_no: 1 },
      { moment_id: "2", fmv_usd: null, pack_no: 2 },
    ])
    expect(s).toEqual({ pool_fmv_usd: 4, unpriced_count: 1, mean_pack_usd: null, median_pack_usd: null, best_pack_usd: null })
  })

  it("summarizePackValues withholds per-pack values before sealing", () => {
    const s = summarizePackValues([{ moment_id: "1", fmv_usd: 4, pack_no: null }])
    expect(s.pool_fmv_usd).toBe(4)
    expect(s.mean_pack_usd).toBeNull()
    expect(summarizePackValues([]).mean_pack_usd).toBeNull()
  })

  it("the prize cap is the NY/FL registration line", () => {
    expect(PRIZE_VALUE_CAP_USD).toBe(5000)
  })
})
