#!/usr/bin/env node
// scripts/qa/light-contrast-sweep.mjs — rendered-contrast check for the LIGHT theme (2026-11-17).
//
// WHY. The brand-token guard (scripts/check-brand-tokens.mjs) checks LITERALS in source; nothing measures
// what a page actually PAINTS. Light mode's defect class is a dark-theme colour left on the light canvas:
// pale text on white, or a hardcoded near-black panel. Found with this on 11-17: the squeeze board's
// "ask ≫ FMV" flag (rgb(252,211,77), 1.34:1) and recharts legend labels in the tier gold (#FFD700, 1.31:1).
//
// WHAT. Real Chromium (Playwright), localStorage rpc_theme=light set before boot. For every visible element
// with its own text it walks up to the first opaque background (an ancestor with a background IMAGE is
// skipped — the effective colour cannot be known) and reports WCAG contrast < 1.6:1. It also reports
// near-black panels (luminance < 0.02) covering ≥ 15 % of the viewport. 1.6 is a "cannot read it" bar,
// not WCAG AA (4.5) — this hunts unreadable text, not polish.
//
// USAGE
//   node scripts/qa/light-contrast-sweep.mjs /path/one /path/two …
//   node scripts/qa/light-contrast-sweep.mjs --file paths.txt      (one path per line or space-separated)
//   ⚠ Git Bash rewrites a leading "/" into a Windows path: prefix MSYS_NO_PATHCONV=1.
//
// ENV  RPC_QA_CHROME (explicit Chromium binary) · RPC_QA_BASE (default https://www.rippackscity.com) · RPC_QA_CONC (default 3) · RPC_QA_SETTLE_MS (9000)
//
// OUTPUT  one JSON line per FLAGGED page (or a page that failed to load / did not render light), then
//   "checked N; flagged M". Exit code 1 when anything is flagged.
//
// POSITIVE CONTROL (run it after changing the measurement): a page with `color:#fafafa` text on a white
// body and a 1200×500 `#050505` div must be flagged (text 1.04:1 + one panel) and `color:#111` text must not.

import { readFileSync } from "node:fs"
import { chromium } from "playwright"

const BASE = (process.env.RPC_QA_BASE || "https://www.rippackscity.com").replace(/\/$/, "")
const CONC = Math.max(1, Number(process.env.RPC_QA_CONC) || 3)
const SETTLE = Math.max(0, Number(process.env.RPC_QA_SETTLE_MS) || 9000)

const args = process.argv.slice(2)
const paths =
  args[0] === "--file"
    ? readFileSync(args[1], "utf8").split(/\s+/).filter(Boolean)
    : args
if (paths.length === 0) {
  console.error("usage: light-contrast-sweep.mjs /path … | --file paths.txt")
  process.exit(2)
}

/** Runs in the page. Returns the light-theme findings for the current document. */
function measure() {
  const theme = document.documentElement.dataset.theme || ""
  const lum = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const [r, g, b, a = 1] = m[1].split(",").map(Number)
    if (a < 0.5) return null
    const f = (v) => {
      v /= 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null
      const L = lum(cs.backgroundColor)
      if (L !== null) return L
    }
    return lum(getComputedStyle(document.body).backgroundColor) ?? 1
  }
  const bad = []
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
    if (own.length < 2) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.3) continue
    const fg = lum(cs.color)
    const bg = bgOf(el)
    if (fg === null || bg === null) continue
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
    if (ratio < 1.6) bad.push({ text: own.slice(0, 40), ratio: +ratio.toFixed(2), color: cs.color, cls: String(el.className || "").slice(0, 60) })
  }
  const panels = []
  const vArea = innerWidth * innerHeight
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect()
    if (rect.width * rect.height < vArea * 0.15) continue
    const L = lum(getComputedStyle(el).backgroundColor)
    if (L !== null && L < 0.02) panels.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 70) })
  }
  return { theme, lowContrast: bad.length, sample: bad.slice(0, 6), darkPanels: panels.slice(0, 4) }
}

// RPC_QA_CHROME: an explicit Chromium binary, as in mobile-sweep.mjs (the cloud sandbox ships a
// different revision than the repo's Playwright expects and `playwright install` is forbidden there).
const browser = await chromium.launch(process.env.RPC_QA_CHROME ? { executablePath: process.env.RPC_QA_CHROME } : {})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("rpc_theme", "light")
  } catch {
    // storage blocked: the page then renders dark and is reported as not-light
  }
})

const results = []
let next = 0
async function worker() {
  while (next < paths.length) {
    const path = paths[next++]
    const page = await ctx.newPage()
    try {
      await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45_000 })
      await page.waitForTimeout(SETTLE)
      results.push({ path, ...(await page.evaluate(measure)) })
    } catch (e) {
      results.push({ path, error: String(e).split("\n")[0].slice(0, 160) })
    } finally {
      await page.close()
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker))
await browser.close()

const flagged = results.filter((r) => r.error || r.theme !== "light" || r.lowContrast > 0 || r.darkPanels?.length)
for (const r of flagged) console.log(JSON.stringify(r))
console.log(`checked ${results.length}; flagged ${flagged.length}`)
process.exit(flagged.length > 0 ? 1 : 0)
