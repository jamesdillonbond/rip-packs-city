import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-07: browsers print without backgrounds, so the dark theme printed
// near-white text on white paper (a printed trophy case was blank). The print
// block in app/globals.css borrows the light theme's structural tokens from
// app/rpc-tokens.css and hides the repeating chrome. Two things can rot: the
// borrowed values drifting from the light block, and the chrome hooks moving.

const GLOBALS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8")
const TOKENS = readFileSync(join(__dirname, "..", "app", "rpc-tokens.css"), "utf8")

function block(css: string, selector: string): string {
  const i = css.indexOf(selector)
  expect(i, `${selector} present`).toBeGreaterThan(-1)
  return css.slice(i, css.indexOf("\n}", i))
}
function decls(b: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of b.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

describe("@media print borrows the light theme", () => {
  const printStart = GLOBALS.indexOf("@media print {")
  it("declares a print block", () => expect(printStart).toBeGreaterThan(-1))
  const printBlock = GLOBALS.slice(printStart, GLOBALS.indexOf("\n}\n", printStart))
  const printTokens = decls(block(printBlock, ":root, [data-theme=\"dark\"] {"))
  const light = decls(block(TOKENS, '[data-theme="light"] {'))

  it("every token it overrides is a light-theme token with the SAME value (keep them in step)", () => {
    const names = Object.keys(printTokens)
    expect(names.length).toBeGreaterThanOrEqual(10)
    const drift = names.filter((n) => n !== "rpc-header-bg" && light[n] !== undefined && light[n] !== printTokens[n]).map((n) => `${n}: print ${printTokens[n]} vs light ${light[n]}`)
    expect(drift).toEqual([])
    const unknown = names.filter((n) => light[n] === undefined)
    expect(unknown, "a print token the light theme does not define").toEqual([])
  })
  it("covers the canvas and the text tokens", () => {
    for (const n of ["rpc-black", "rpc-surface", "rpc-text-primary", "rpc-text-secondary", "rpc-text-muted", "rpc-border"]) expect(printTokens[n], n).toBeDefined()
  })
  it("hides the chrome that repeats per page, by hooks that still exist", () => {
    expect(printBlock).toContain('nav[aria-label="Primary"]')
    expect(readFileSync(join(__dirname, "..", "components", "MobileNav.tsx"), "utf8")).toContain('aria-label="Primary"')
    expect(printBlock).toContain('[data-tour-anchor="chatbot-launcher"]')
    expect(readFileSync(join(__dirname, "..", "components", "SupportChat.tsx"), "utf8")).toContain('data-tour-anchor="chatbot-launcher"')
    expect(printBlock).toContain(".rpc-ticker-track")
    expect(GLOBALS).toContain(".rpc-ticker-track:hover")
  })
})
