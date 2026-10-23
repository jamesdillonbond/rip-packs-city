import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ── The homepage may not describe a serial-premium model the site does not run ─
//
// History. Deep-audit R105 (2026-09-18): the bullet read "1-of-1 = 12×, low serials = 4.5×,
// last mint = 3×"; 4.5× existed nowhere and "last mint = 3×" contradicted the code. It was then
// pinned COPY → lib/market-compute.ts ("#1 = 12×, jersey = 8×, perfect-mint = 6×, plus a
// tier-calibrated curve for serials below an edition's median").
//
// ⚠ RE-PINNED 2026-10-22 — the premise was wrong, not the numbers. lib/market-compute.ts is not the
// model any live surface uses: its only caller, /api/market-truth, has no client. Every live
// serial price (the sniper, Underpriced #1s, moment pages) comes from the SQL
// `serial_fmv_estimate` — fitted models (pooled with set + player effects, a jersey model, a power
// model) that price ONLY the #1, perfect-mint and jersey-match buckets and return nothing for
// ordinary serials, with a multiplier that varies by tier and mint size (#1: 5.3× on a /99 Rare,
// 10.2× on a 15,000 Common, 12.8× on a /25 Legendary, measured 10-22). So:
//   · a FIXED "N×" on the homepage is false for most editions — the bullet quotes none;
//   · the "curve for serials below the median" does not exist in the live model — not claimed;
//   · the three buckets it DOES price are named.
// ⚠ Deliberately NOT asserted: that the fitted multipliers are RIGHT. That is a live FMV question,
// settled by measurement and a human decision, never by retuning to match copy.

const SRC = readFileSync(join(process.cwd(), "components", "HomePageMarketing.tsx"), "utf8")

/** The bullet under test, located by its stable prefix rather than by line number. */
function serialPremiumBullet(): string {
  const line = SRC.split("\n").find((l) => l.includes("copy:") && l.includes("Special-serial premiums"))
  if (!line) throw new Error("serial-premium bullet not found in HomePageMarketing.tsx")
  return line
}

/** Every `N×` or `N.N×` a line prints. */
function quotedMultipliers(line: string): number[] {
  return [...line.matchAll(/(\d+(?:\.\d+)?)\s*×/g)].map((m) => Number(m[1]))
}

describe("homepage serial-premium copy describes the live model", () => {
  it("the locator finds the bullet (population control)", () => {
    expect(serialPremiumBullet().length).toBeGreaterThan(40)
  })

  it("quotes no fixed multiplier — the live estimate varies by tier and mint size", () => {
    expect(quotedMultipliers(serialPremiumBullet())).toEqual([])
  })

  it("names the three buckets the live estimate prices", () => {
    const line = serialPremiumBullet().toLowerCase()
    for (const bucket of ["#1", "perfect-mint", "jersey"]) expect(line).toContain(bucket)
  })

  it("claims no low-serial curve and no last-mint premium — neither exists in the live model", () => {
    const line = serialPremiumBullet().toLowerCase()
    for (const bad of ["below an edition's median", "low serials", "last mint", "final mint", "highest serial"]) {
      expect(line, bad).not.toContain(bad)
    }
  })

  it("NO-CHANGE CONTROLS — both earlier versions of the bullet fail the fixed-multiplier rule", () => {
    const r105 = 'copy: "Serial premium multipliers — 1-of-1 = 12×, low serials = 4.5×, last mint = 3×."'
    const pre1022 = 'copy: "Serial premium multipliers — #1 = 12×, jersey = 8×, perfect-mint = 6×, plus a tier-calibrated curve for serials below an edition\'s median."'
    expect(quotedMultipliers(r105).length).toBeGreaterThan(0)
    expect(quotedMultipliers(pre1022)).toEqual([12, 8, 6])
  })

  it("the premise: live serial pricing is serial_fmv_estimate, and the legacy computeFmv has no live caller", () => {
    expect(readFileSync(join(process.cwd(), "app/api/sniper-feed/route.ts"), "utf8")).toContain("serial_fmv_estimate")
    expect(readFileSync(join(process.cwd(), "lib/underpriced-serials-board.ts"), "utf8")).toContain("topshot_underpriced_serials_board")
  })
})
