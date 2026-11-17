import { describe, it, expect } from "vitest"
import {
  PINNACLE_SERIAL_MIN_MINT,
  pinnacleSerialBand,
  pinnacleSerialFmv,
  pinnacleSerialLadder,
  toMultiplierMap,
  pinnacleSerialFmvData,
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
// ⚠ 2026-09-27: #1 + perfect only (Trevor — the shared serial_fmv_estimate
// pattern). Live refit that day: first 14.45 (n=50), perfect 3.49 (n=36).
const LIVE: PinnacleSerialMultipliers = { first: 15.7741, perfect: 3.49, normal: 1 }

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
        { band: "first", multiplier: "not-a-number", is_reliable: true },
        { band: "perfect", multiplier: 0, is_reliable: true },
      ]),
    ).toEqual({})
  })

  it("drops a STALE low5 / low20 row (the pre-2026-09-27 fit) — those bands no longer exist", () => {
    expect(
      toMultiplierMap([
        { band: "low5", multiplier: 2.45, is_reliable: true },
        { band: "low20", multiplier: 1.23, is_reliable: true },
        { band: "perfect", multiplier: 3.49, is_reliable: true },
      ]),
    ).toEqual({ perfect: 3.49 })
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

  // INVERTED 2026-09-27: this case pinned the top-5% / top-20% bands. A low serial
  // now earns NO premium — only #1 and perfect do.
  it("a LOW serial is `normal` — no top-5% / top-20% band exists any more", () => {
    expect(pinnacleSerialBand(2, 100)).toBe("normal")
    expect(pinnacleSerialBand(5, 100)).toBe("normal")
    expect(pinnacleSerialBand(20, 100)).toBe("normal")
    expect(pinnacleSerialBand(99, 100)).toBe("normal")
  })

  it("the LAST serial of a mint > 1 is `perfect`", () => {
    expect(pinnacleSerialBand(100, 100)).toBe("perfect")
    expect(pinnacleSerialBand(2, 2)).toBe("perfect")
    // #1 of 1 is `first`, not perfect (precedence, same as the SQL)
    expect(pinnacleSerialBand(1, 1)).toBe("first")
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
    expect(pinnacleSerialFmv(1, 500, 10, { perfect: 3.49 }, guard)).toBeNull()
    expect(pinnacleSerialFmv(500, 500, 10, { first: 14 }, guard)).toBeNull()
  })

  it("prices a perfect serial with the perfect multiplier", () => {
    expect(pinnacleSerialFmv(500, 500, 10, LIVE, guard)).toEqual({ band: "perfect", multiplier: 3.49, estimate: 34.9 })
  })

  it("claims a #1 / perfect premium only over a HIGH or MEDIUM base (the shared gate)", () => {
    expect(pinnacleSerialFmv(1, 500, 10, LIVE, { ...guard, baseConfidence: "HIGH" })).not.toBeNull()
    expect(pinnacleSerialFmv(1, 500, 10, LIVE, { ...guard, baseConfidence: "medium" })).not.toBeNull()
    expect(pinnacleSerialFmv(1, 500, 10, LIVE, { ...guard, baseConfidence: "LOW" })).toBeNull()
    expect(pinnacleSerialFmv(500, 500, 10, LIVE, { ...guard, baseConfidence: "ASK_ONLY" })).toBeNull()
    expect(pinnacleSerialFmv(1, 500, 10, LIVE, { ...guard, baseConfidence: null })).toBeNull()
    // a normal serial is not a premium claim — the gate does not apply to it
    expect(pinnacleSerialFmv(7, 500, 10, LIVE, { ...guard, baseConfidence: "LOW" })).toEqual({ band: "normal", multiplier: 1, estimate: 10 })
  })

  it("without the guard it reproduces the raw fitted model at any mint", () => {
    const r = pinnacleSerialFmv(1, 5, 100, LIVE)
    expect(r!.estimate).toBe(1577.41)
  })
})

describe("pinnacleSerialLadder", () => {
  it("builds #1 / perfect / typical, descending", () => {
    const rows = pinnacleSerialLadder(500, 10, LIVE)!
    expect(rows.map((r) => r.label)).toEqual(["#1", "perfect", "typical"])
    expect(rows[1].note).toBe("#500 of 500 (the last serial)")
    expect(rows[2]).toEqual({ label: "typical", note: "every other serial", estimate: 10, mult: 1 })
    for (let i = 1; i < rows.length; i++) expect(rows[i].estimate).toBeLessThan(rows[i - 1].estimate)
  })

  it("returns null below the mint guard, unpriced, a LOW base, or with no premium band available", () => {
    expect(pinnacleSerialLadder(PINNACLE_SERIAL_MIN_MINT - 1, 10, LIVE)).toBeNull()
    expect(pinnacleSerialLadder(500, null, LIVE)).toBeNull()
    expect(pinnacleSerialLadder(500, 10, { normal: 1 })).toBeNull()
    expect(pinnacleSerialLadder(500, 10, LIVE, "LOW")).toBeNull()
    expect(pinnacleSerialLadder(500, 10, LIVE, "HIGH")).not.toBeNull()
  })
})

describe("pinnacleSerialFmvData — the shared SerialFmvData shape", () => {
  it("emits the badge shape for #1 and perfect", () => {
    expect(pinnacleSerialFmvData({ band: "first", multiplier: 14.456, estimate: 144.56 })).toMatchObject({
      estimate_usd: 144.56, multiplier: 14.46, serial_bucket: "first", label: "estimated #1 premium",
    })
    expect(pinnacleSerialFmvData({ band: "perfect", multiplier: 3.49, estimate: 34.9 })).toMatchObject({
      serial_bucket: "perfect", label: "estimated perfect-mint premium",
    })
  })
  it("a normal serial or no estimate is NOT a serial estimate", () => {
    expect(pinnacleSerialFmvData({ band: "normal", multiplier: 1, estimate: 10 })).toBeNull()
    expect(pinnacleSerialFmvData(null)).toBeNull()
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
  else if (mint !== null && mint > 1 && serial === mint) band = "perfect"
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
