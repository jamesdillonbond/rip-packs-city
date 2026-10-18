import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COLLECTIONS } from "@/lib/collections"
import { accentText } from "@/lib/accent-text"

// A collection ACCENT painted as TEXT clears WCAG AA (4.5:1) in BOTH themes,
// for EVERY accent in the registry (known-issues #194 a, 2026-10-18).
//
// Pins the PROPERTY, not the numbers: the mix amounts are read from
// app/rpc-tokens.css and the accents from lib/collections.ts, so a new
// collection with an unreadable accent — or a token edit that weakens the mix —
// fails here. The backgrounds are the worst ones axe named on production: the
// page canvases, a raised card, and the accent's own tinted chip (`${accent}18`
// over the canvas, CollectionSwitcher's active pill).

const CSS = readFileSync(join(__dirname, "..", "app", "rpc-tokens.css"), "utf8")
type RGB = [number, number, number]

function block(selector: string): string {
  const i = CSS.indexOf(selector)
  expect(i, `${selector} block present`).toBeGreaterThan(-1)
  return CSS.slice(i, CSS.indexOf("\n}", i))
}
function token(b: string, name: string): string {
  const m = b.match(new RegExp(`--${name}:\\s*([^;]+);`))
  expect(m, `--${name} declared`).not.toBeNull()
  return m![1].trim()
}
const hex = (h: string): RGB => {
  const m = h.replace("#", "").match(/^([0-9a-f]{6})$/i)
  expect(m, `hex colour: ${h}`).not.toBeNull()
  return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB
}
// color-mix(in srgb, A, B p%) blends the gamma-encoded channels.
const mix = (a: RGB, b: RGB, p: number): RGB => a.map((v, i) => Math.round(v * (1 - p) + b[i] * p)) as RGB
function lum([r, g, b]: RGB): number {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a: RGB, b: RGB) => {
  const x = lum(a), y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const THEMES = [
  { name: "dark", b: block(":root {"), raised: hex("202020") },
  { name: "light", b: block('[data-theme="light"] {'), raised: hex("ebebeb") },
]
const ACCENTS = [...new Set(COLLECTIONS.map((c) => c.accent).filter(Boolean))]

describe("accentText()", () => {
  it("maps the brand red to the text-safe red, passes tokens through, mixes the rest", () => {
    expect(accentText("#E03A2F")).toBe("var(--rpc-red-text)")
    expect(accentText("e03a2f")).toBe("var(--rpc-red-text)")
    expect(accentText("var(--rpc-accent)")).toBe("var(--rpc-accent)")
    expect(accentText("#4F94D4")).toBe("color-mix(in srgb, #4F94D4, var(--rpc-accent-text-mix) var(--rpc-accent-text-amt))")
    expect(accentText(undefined)).toBeUndefined()
    expect(accentText(null)).toBeUndefined()
  })
})

describe("every registry accent, as text, clears AA in both themes", () => {
  it("reads a real population of accents (not vacuous)", () => {
    expect(ACCENTS.length).toBeGreaterThanOrEqual(6)
  })

  for (const t of THEMES) {
    const withC = hex(token(t.b, "rpc-accent-text-mix"))
    const amt = parseFloat(token(t.b, "rpc-accent-text-amt")) / 100
    const redText = hex(token(t.b, "rpc-red-text"))
    const canvases = ["rpc-black", "rpc-surface", "rpc-bg"].map((c) => hex(token(t.b, c)))
    for (const a of ACCENTS) {
      it(`${t.name}: ${a}`, () => {
        const out = accentText(a)!
        const fg = out === "var(--rpc-red-text)" ? redText : mix(hex(a), withC, amt)
        for (const base of canvases) {
          for (const bg of [base, t.raised, mix(base, hex(a), 0x18 / 255)]) {
            const r = contrast(fg, bg)
            expect(r, `${a} → ${out} on rgb(${bg}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
          }
        }
      })
    }
  }

  it("the calculator is not vacuous: a RAW accent fails somewhere (that is why the helper exists)", () => {
    const light = THEMES[1]
    const white = hex(token(light.b, "rpc-bg"))
    expect(ACCENTS.some((a) => contrast(hex(a), white) < 4.5)).toBe(true)
  })
})
