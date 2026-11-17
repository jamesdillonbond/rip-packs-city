import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// WCAG AA contrast for the TEXT tokens, computed from app/rpc-tokens.css in
// BOTH themes — the first scheduled axe audit (e2e/a11y.spec.ts, 2026-10-12)
// read `serious · color-contrast` on every route it visited, and the bulk of
// those nodes were --rpc-text-muted (4.10:1 dark, 3.31:1 light) plus the red
// handle (--rpc-red-muted, 1.9:1). Pinning the RATIO rather than the alpha:
// a future palette change is free to pick any value that still clears 4.5:1.
//
// A token's contrast is only meaningful against the surfaces it is painted on,
// so each text token is checked against every canvas token of its theme.

const CSS = readFileSync(join(__dirname, "..", "app", "rpc-tokens.css"), "utf8")

type RGB = [number, number, number]
function themeBlock(selector: string): string {
  const i = CSS.indexOf(selector)
  expect(i, `${selector} block present`).toBeGreaterThan(-1)
  return CSS.slice(i, CSS.indexOf("\n}", i))
}
function token(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
  expect(m, `--${name} declared`).not.toBeNull()
  return m![1].trim()
}
function parse(v: string): { rgb: RGB; a: number } {
  const hex = v.match(/^#([0-9a-f]{6})$/i)
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as RGB, a: 1 }
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/)
  expect(m, `parseable colour: ${v}`).not.toBeNull()
  return { rgb: [Number(m![1]), Number(m![2]), Number(m![3])], a: m![4] === undefined ? 1 : Number(m![4]) }
}
function over(fg: { rgb: RGB; a: number }, bg: RGB): RGB {
  return bg.map((c, i) => Math.round(fg.rgb[i] * fg.a + c * (1 - fg.a))) as RGB
}
function lum([r, g, b]: RGB): number {
  const f = (c: number) => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
export function contrast(fg: RGB, bg: RGB): number {
  const a = lum(fg), b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const THEMES = [
  { name: "dark", block: themeBlock(":root {") },
  { name: "light", block: themeBlock('[data-theme="light"] {') },
]
const CANVASES = ["rpc-black", "rpc-surface", "rpc-bg"]
const TEXT_TOKENS = ["rpc-text-primary", "rpc-text-secondary", "rpc-text-muted", "rpc-red-text"]

describe("text tokens clear WCAG AA (4.5:1) on every canvas of their theme", () => {
  for (const theme of THEMES) {
    for (const t of TEXT_TOKENS) {
      for (const c of CANVASES) {
        it(`${theme.name}: --${t} on --${c}`, () => {
          const bg = parse(token(theme.block, c))
          expect(bg.a, `canvas --${c} is opaque`).toBe(1)
          const fg = over(parse(token(theme.block, t)), bg.rgb)
          const ratio = contrast(fg, bg.rgb)
          expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
  }
})

describe("the calculator is not vacuous", () => {
  it("reads the ghost token as FAILING (it is decorative, not text, and must stay out of TEXT_TOKENS)", () => {
    for (const theme of THEMES) {
      const bg = parse(token(theme.block, "rpc-surface"))
      const fg = over(parse(token(theme.block, "rpc-text-ghost")), bg.rgb)
      expect(contrast(fg, bg.rgb)).toBeLessThan(4.5)
    }
  })
  it("matches the published reference pair (black on white = 21:1)", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
  })
})

describe("the red handle is painted with the text-safe red, not the fill red", () => {
  // The two header handles are 9 px mono — the smallest text on the site —
  // and were the first color-contrast node axe named on every route.
  for (const f of ["components/GlobalSiteHeader.tsx", "components/HomePageMarketing.tsx"]) {
    it(f, () => {
      const src = readFileSync(join(__dirname, "..", f), "utf8")
      const i = src.indexOf("@RIPPACKSCITY")
      expect(i).toBeGreaterThan(-1)
      const before = src.slice(Math.max(0, i - 400), i)
      expect(before).toContain("var(--rpc-red-text)")
      expect(before).not.toMatch(/rpc-red-muted|rgba\(224,\s*58,\s*47/)
    })
  }
})

// 2026-11-07 — TIER CHIP TEXT ON ITS OWN TINT, OVER NESTED CARDS. axe in light
// mode on /players/<slug> and /teams/<league>/<slug> read every tier chip at
// 4.12–4.49:1: the chip's --tier-*-text sat on --tier-*-bg (a 10 % tint) over
// THREE nested .rpc-card layers (each --rpc-surface-raised, rgba(0,0,0,0.04) in
// light), a darker canvas than the one-card tint the 10-18 values were tuned
// on. The property: a tier text token clears 4.5:1 on its own tint over the
// canvas, over one, two and three stacked cards, AND over three cards with the
// hover surface on top — in both themes. Resolves `var(--x)` one level.
const TIERS = ["legendary", "ultimate", "rare", "fandom", "uncommon", "common", "champion", "challenger", "contender", "epic"]
// A theme block inherits what it does not redeclare (the tints live only in :root).
function inherited(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
  return m ? m[1].trim() : token(THEMES[0].block, name)
}
function resolve(block: string, v: string): string {
  const m = v.match(/^var\(--([a-z-]+)\)$/)
  return m ? inherited(block, m[1]) : v
}
describe("tier chip text clears AA on its own tint over nested cards", () => {
  for (const theme of THEMES) {
    const canvas = parse(token(theme.block, "rpc-black")).rgb
    const raised = parse(token(theme.block, "rpc-surface-raised"))
    const hover = parse(token(theme.block, "rpc-surface-hover"))
    const one = over(raised, canvas), two = over(raised, one), three = over(raised, two)
    const stacks: Array<[string, RGB]> = [["canvas", canvas], ["1 card", one], ["2 cards", two], ["3 cards", three], ["3 cards + hover", over(hover, three)]]
    for (const tier of TIERS) {
      it(`${theme.name}: --tier-${tier}-text on --tier-${tier}-bg`, () => {
        const fg = parse(resolve(theme.block, inherited(theme.block, `tier-${tier}-text`)))
        const tint = parse(resolve(theme.block, inherited(theme.block, `tier-${tier}-bg`)))
        expect(fg.a).toBe(1)
        for (const [name, under] of stacks) {
          const bg = over(tint, under)
          const ratio = contrast(fg.rgb, bg)
          expect(ratio, `${ratio.toFixed(2)}:1 over ${name}`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }
})
