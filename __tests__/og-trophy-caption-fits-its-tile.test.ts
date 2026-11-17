import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

import { caseTileWidth, captionCharBudget } from "@/app/api/og/trophy-case/[username]/route"

// ─────────────────────────────────────────────────────────────────────────────
// The trophy-case card clips each detail line to a CHARACTER budget derived from
// the tile width, because satori's `text-overflow: ellipsis` no-ops often enough
// that counting characters is the thing that actually holds (see lib/og/
// trophy-detail.ts). A budget that over-counts does not clip — it WRAPS, and a
// second line inside a fixed 13px box is sliced through the middle, so both
// lines read as a smear.
//
// ⭐ THIS GUARD EXISTS BECAUSE THE FIRST FIX FOR THAT ESTIMATED THE ADVANCE AND
// GOT THE MAGNITUDE WRONG. "Mono is about 0.6em" gives 6.3px per character at
// 10px and an over-count of ~12%. The actual face is 0.540em — 5.70px — and an
// over-count of ~1.8%. The conclusion survived (it did wrap) but the number did
// not, and a number nobody can re-derive is how the next person picks a divisor
// by feel. So the budget is asserted against the FONT FILE THE CARD SHIPS.
//
// ⚠ NOTHING ELSE IN CI MEASURES LAYOUT — jsdom boxes are zero and only the real
// browser in e2e/ sees geometry, and it never renders an OG card. This is the
// only thing standing between a font swap and a silently smeared caption.
// ─────────────────────────────────────────────────────────────────────────────

const root = process.cwd()
const ROUTE = "app/api/og/trophy-case/[username]/route.tsx"

/** Modal glyph advance in font units, plus unitsPerEm, straight from the TTF. */
function fontMetrics(file: string): { upem: number; advance: number; share: number } {
  const b = readFileSync(file)
  const numTables = b.readUInt16BE(4)
  const tables: Record<string, number> = {}
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16
    tables[b.toString("ascii", o, o + 4)] = b.readUInt32BE(o + 8)
  }
  const upem = b.readUInt16BE(tables["head"] + 18)
  const numH = b.readUInt16BE(tables["hhea"] + 34)
  const counts = new Map<number, number>()
  for (let i = 0; i < numH; i++) {
    const a = b.readUInt16BE(tables["hmtx"] + i * 4)
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  const [advance, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]
  return { upem, advance, share: n / numH }
}

/**
 * The two style numbers the card actually renders the detail lines with, read
 * out of the route rather than restated here.
 *
 * ⚠ A guard that hardcodes its own copy of the font size is measuring a model,
 * not the card — it keeps passing after someone bumps the size in the JSX.
 */
function renderedTextStyle(): { fontSize: number; letterSpacing: number } {
  const src = readFileSync(path.join(root, ROUTE), "utf8")
  // The detail-line boxes are the ones that carry a height of 13 — the serial
  // strip above them is a different block with its own size.
  const blocks = [...src.matchAll(/height:\s*13,[\s\S]{0,900}?letterSpacing:\s*([\d.]+)/g)]
  const sizes = [...src.matchAll(/height:\s*13,[\s\S]{0,900}?fontSize:\s*(\d+)/g)]
  expect(blocks.length, "no detail-line block found — the anchor moved").toBeGreaterThan(0)
  expect(sizes.length, "no detail-line fontSize found — the anchor moved").toBeGreaterThan(0)
  const ls = new Set(blocks.map((m) => Number(m[1])))
  const fs = new Set(sizes.map((m) => Number(m[1])))
  expect(ls.size, "the two detail lines disagree about letter-spacing").toBe(1)
  expect(fs.size, "the two detail lines disagree about font size").toBe(1)
  return { fontSize: [...fs][0], letterSpacing: [...ls][0] }
}

const MONO = path.join(root, "public/fonts/ShareTechMono-Regular.ttf")

describe("the caption budget fits the tile it is measured against", () => {
  const m = fontMetrics(MONO)
  const { fontSize, letterSpacing } = renderedTextStyle()
  const advancePx = (m.advance / m.upem) * fontSize + letterSpacing

  it("the shipped face really is monospace, or the whole model is wrong", () => {
    // A proportional font makes "characters per pixel" meaningless, and every
    // assertion below would be measuring nothing. 191 of 194 glyphs share one
    // advance today.
    expect(m.share).toBeGreaterThan(0.95)
    expect(m.upem).toBeGreaterThan(0)
  })

  it("records the measured advance so a font swap is visible in the diff", () => {
    // ⚠ A DATED SAMPLE of the FILE, not a constant: Share Tech Mono is 0.540em,
    // NOT the 0.6em a generic mono estimate assumes. That 11% gap is the whole
    // reason this file exists.
    expect((m.advance / m.upem).toFixed(3)).toBe("0.540")
    expect(advancePx.toFixed(2)).toBe("5.70")
  })

  it("every tile width the card can render holds its own budget on ONE line", () => {
    for (let n = 1; n <= 6; n++) {
      const w = caseTileWidth(n)
      const used = captionCharBudget(w) * advancePx
      expect(used, `${n} tiles (w=${w}): ${used.toFixed(1)}px of caption in ${w}px`).toBeLessThanOrEqual(w)
    }
  })

  it("⭐ and it is TIGHT — one more character would not fit at the two live widths", () => {
    // Without this the guard passes for a budget of 1 character. It asserts the
    // DELTA the divisor stands for, not merely that something fits.
    //
    // ⚠ n=6 (170px) and n=1 (280px) are the widths with live collectors behind
    // them: 3 of the 7 who have pinned anything have six trophies and 4 have
    // one. The in-between widths are real code paths with no live population,
    // so they are asserted for fit above but not for tightness.
    for (const n of [6, 1]) {
      const w = caseTileWidth(n)
      expect((captionCharBudget(w) + 1) * advancePx, `w=${w} has a spare character`).toBeGreaterThan(w)
    }
  })

  it("CONTROL: the divisor that shipped the defect fails this guard", () => {
    // The pre-2026-09-12 budget, restated here so the guard is proven able to
    // FAIL rather than trusted to. w=170 -> 30 chars x 5.70 = 171.0px in 170px,
    // which is how Disney Pinnacle's 51-character set name came to wrap.
    const old = (w: number) => Math.max(12, Math.floor(w / 5.6))
    const overflowed = [1, 2, 3, 4, 5, 6]
      .map((n) => caseTileWidth(n))
      .filter((w) => old(w) * advancePx > w)
    expect(overflowed.length, "the old divisor fitted everywhere — this control proves nothing").toBeGreaterThan(0)
    expect(overflowed).toContain(170)
  })

  it("the floor is not silently doing the work at any real width", () => {
    // captionCharBudget floors at 12. If a width ever fell to the floor, the
    // fit assertions above would be testing the floor rather than the divisor.
    for (let n = 1; n <= 6; n++) {
      expect(captionCharBudget(caseTileWidth(n))).toBeGreaterThan(12)
    }
  })
})
