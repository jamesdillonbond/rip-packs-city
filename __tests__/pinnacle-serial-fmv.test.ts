import { describe, it, expect } from "vitest"
import {
  PINNACLE_SERIAL_MIN_MINT,
  pinnacleSerialBand,
  pinnacleSerialFmv,
  pinnacleSerialLadder,
  toMultiplierMap,
  type PinnacleSerialMultipliers,
} from "@/lib/pinnacle/serial-fmv"

// Unit tests for the Disney Pinnacle serial-premium overlay.
//
// The reason this module exists is that the band boundaries were implemented
// twice — once in SQL (`pinnacle_serial_fmv_estimate`) and once inline in the
// moment page. The most important test here is the CROSS-AGREEMENT test at the
// bottom, which reimplements the SQL branch structure independently and asserts
// the TypeScript agrees with it across a swept grid. If someone edits one copy
// of a pricing rule, that test is what catches the drift.

// Live values on 2026-07-26 (compute_pinnacle_serial_fmv_multipliers, refit
// weekly). Exact numbers don't matter to the logic — the shape does.
const LIVE: PinnacleSerialMultipliers = { first: 15.7741, low5: 2.1926, low20: 1.183, normal: 1 }

describe("toMultiplierMap", () => {
  it("keeps reliable bands and coerces string numerics", () => {
    expect(
      toMultiplierMap([
        { band: "first", multiplier: "15.77", is_reliable: true },
        { band: "normal", multiplier: 1, is_reliable: true },
      ]),
    ).toEqual({ first: 15.77, normal: 1 })
  })

  it("DROPS unreliable bands rather than defaulting them to 1.0", () => {
    const m = toMultiplierMap([{ band: "first", multiplier: 15.77, is_reliable: false }])
    expect(m.first).toBeUndefined()
  })

  it("drops unknown bands and non-finite / non-positive multipliers", () => {
    expect(
      toMultiplierMap([
        { band: "chase", multiplier: 4, is_reliable: true },
        { band: "low5", multiplier: "not-a-number", is_reliable: true },
        { band: "low20", multiplier: 0, is_reliable: true },
      ]),
    ).toEqual({})
  })

  it("tolerates null / undefined input", () => {
    expect(toMultiplierMap(null)).toEqual({})
    expect(toMultiplierMap(undefined)).toEqual({})
  })
})

describe("pinnacleSerialBand", () => {
  it("serial #1 is `first` regardless of mint", () => {
    expect(pinnacleSerialBand(1, 5)).toBe("first")
    expect(pinnacleSerialBand(1, 100000)).toBe("first")
    expect(pinnacleSerialBand(1, null)).toBe("first")
  })

  it("has no band for a missing or non-positive serial", () => {
    expect(pinnacleSerialBand(null, 100)).toBeNull()
    expect(pinnacleSerialBand(0, 100)).toBeNull()
    expect(pinnacleSerialBand(-3, 100)).toBeNull()
  })

  it("reads as `normal` when the mint cannot express a position", () => {
    expect(pinnacleSerialBand(4, null)).toBe("normal")
    expect(pinnacleSerialBand(4, 1)).toBe("normal")
  })

  it("splits low5 / low20 / normal on the position boundaries INCLUSIVELY", () => {
    // mint 100: 5/100 = 0.05 exactly -> low5; 6 -> low20; 20/100 = 0.20 -> low20; 21 -> normal
    expect(pinnacleSerialBand(5, 100)).toBe("low5")
    expect(pinnacleSerialBand(6, 100)).toBe("low20")
    expect(pinnacleSerialBand(20, 100)).toBe("low20")
    expect(pinnacleSerialBand(21, 100)).toBe("normal")
  })
})

describe("pinnacleSerialFmv", () => {
  const guard = { applyMinMintGuard: true }

  it("applies the band multiplier and rounds to cents", () => {
    const r = pinnacleSerialFmv(1, 500, 10, LIVE, guard)
    expect(r).not.toBeNull()
    expect(r!.band).toBe("first")
    expect(r!.estimate).toBe(157.74)
  })

  it("returns base FMV at 1.0 for a normal serial — 'no premium' is not 'not estimable'", () => {
    const r = pinnacleSerialFmv(400, 500, 10, LIVE, guard)
    expect(r).toEqual({ band: "normal", multiplier: 1, estimate: 10 })
  })

  it("declines (null) below the mint guard rather than publishing a ~15.8x #1", () => {
    expect(pinnacleSerialFmv(1, PINNACLE_SERIAL_MIN_MINT - 1, 4500, LIVE, guard)).toBeNull()
    expect(pinnacleSerialFmv(1, PINNACLE_SERIAL_MIN_MINT, 4500, LIVE, guard)).not.toBeNull()
  })

  it("declines when the mint is unknown and the guard is on", () => {
    expect(pinnacleSerialFmv(1, null, 100, LIVE, guard)).toBeNull()
  })

  it("declines on a missing, zero or negative base FMV — never fabricates a value", () => {
    expect(pinnacleSerialFmv(1, 500, null, LIVE, guard)).toBeNull()
    expect(pinnacleSerialFmv(1, 500, 0, LIVE, guard)).toBeNull()
    expect(pinnacleSerialFmv(1, 500, -5, LIVE, guard)).toBeNull()
  })

  it("declines when the band has no reliable multiplier", () => {
    expect(pinnacleSerialFmv(1, 500, 10, { low20: 1.18 }, guard)).toBeNull()
  })

  it("without the guard it reproduces the raw fitted model at any mint", () => {
    const r = pinnacleSerialFmv(1, 5, 100, LIVE)
    expect(r!.estimate).toBe(1577.41)
  })
})

describe("pinnacleSerialLadder", () => {
  it("builds first / low5 / low20 / typical, descending, with the top-5% cutoff", () => {
    const rows = pinnacleSerialLadder(500, 10, LIVE)!
    expect(rows.map((r) => r.label)).toEqual(["#1", "low serial", "mid serial", "typical"])
    expect(rows[1].note).toBe("#2–#25 (top 5%)")
    expect(rows[3]).toEqual({ label: "typical", note: "most serials", estimate: 10, mult: 1 })
    for (let i = 1; i < rows.length; i++) expect(rows[i].estimate).toBeLessThan(rows[i - 1].estimate)
  })

  it("floors the top-5% cutoff at #2 so a small mint never prints '#2–#1'", () => {
    const rows = pinnacleSerialLadder(30, 10, LIVE)!
    expect(rows[1].note).toBe("#2–#2 (top 5%)")
  })

  it("returns null below the mint guard, unpriced, or with no premium band available", () => {
    expect(pinnacleSerialLadder(PINNACLE_SERIAL_MIN_MINT - 1, 10, LIVE)).toBeNull()
    expect(pinnacleSerialLadder(500, null, LIVE)).toBeNull()
    expect(pinnacleSerialLadder(500, 10, { normal: 1 })).toBeNull()
  })
})

// ── Cross-agreement with the SQL function ──────────────────────────────────
// An INDEPENDENT transcription of the CASE expression in
// pinnacle_serial_fmv_estimate(p_serial, p_mint_count, p_base_fmv). Written from
// the SQL rather than from the TypeScript on purpose — if it were derived from
// the implementation under test it would prove nothing.
function sqlEstimate(
  serial: number | null,
  mint: number | null,
  baseFmv: number | null,
  mults: PinnacleSerialMultipliers,
): number | null {
  let band: string | null
  if (serial === null || serial <= 0 || baseFmv === null) band = null
  else if (serial === 1) band = "first"
  else if (mint === null || mint <= 1) band = "normal"
  else if (serial / mint <= 0.05) band = "low5"
  else if (serial / mint <= 0.2) band = "low20"
  else band = "normal"

  if (baseFmv === null) return null
  if (band === null) return baseFmv
  const m = (mults as Record<string, number | undefined>)[band] ?? 1.0
  return Math.round(baseFmv * m * 100) / 100
}

describe("cross-agreement with pinnacle_serial_fmv_estimate (SQL)", () => {
  it("agrees across a swept serial x mint grid (guard off — the raw model)", () => {
    const base = 37.5
    const mints = [2, 3, 10, 25, 40, 99, 100, 250, 500, 1000, 5000]
    let compared = 0
    for (const mint of mints) {
      for (const serial of [1, 2, 3, 5, 6, 19, 20, 21, 50, mint - 1, mint]) {
        if (serial < 1 || serial > mint) continue
        const ts = pinnacleSerialFmv(serial, mint, base, LIVE)
        expect(ts, `serial ${serial}/${mint} produced no estimate`).not.toBeNull()
        expect(ts!.estimate, `serial ${serial} of ${mint}`).toBe(sqlEstimate(serial, mint, base, LIVE))
        compared++
      }
    }
    expect(compared).toBeGreaterThan(80)
  })

  it("agrees on the null-serial and unknown-mint edges", () => {
    // SQL has no band for a null/non-positive serial and returns base unchanged;
    // the TS declines instead, which is the intentional difference — a caller
    // must not present base FMV as a serial ESTIMATE. Assert both explicitly so
    // the divergence is deliberate and documented rather than accidental.
    expect(sqlEstimate(null, 100, 10, LIVE)).toBe(10)
    expect(pinnacleSerialFmv(null, 100, 10, LIVE)).toBeNull()

    expect(pinnacleSerialFmv(7, null, 10, LIVE)!.estimate).toBe(sqlEstimate(7, null, 10, LIVE))
  })
})
