// 2026-09-25 (Trevor): "we should not have 'DUC' anywhere on our website. DUC
// is pegged 1:1 with the US Dollar. Show DUC just like you would for the
// Dollar. So if a pack was 10 DUC, show it was $10."
//
// Before this, /dashboard/history printed "$35.00 DUC", /dashboard/packs
// "$10.00 DUC" and a "DUC 33 buys · 7 sells" currency strip, the Pinnacle
// sniper footer "Prices in USD (DUC)", two insights boards "Prices are DUC ≈
// USD", the loans dashboard and its methodology listed DUC as a token, and a
// wallet's loan detail could print the raw ticker.
//
// This walks every source file that can render copy — app/ (minus the API
// routes, which return JSON), components/ and lib/ (minus lib/chains, whose
// Cadence transaction sources are on-chain assertion text, never rendered) —
// strips comments, removes the bare-literal form (`"DUC"` / `'DUC'`, the value
// a currency column carries and a formatter compares against), and bans any
// remaining word "DUC" at zero. A tree walk, not a curated list: a new page
// that says "DUC" is caught the day it is written.
//
// The formatter contract the walk relies on — a dollar-pegged unit renders as
// plain dollars — is pinned alongside, with a planted-defect proof that the
// scanner sees what the walk bans.

import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { currencySuffix, displayCurrency, isUsdPegged } from "@/lib/usd-format"
import { fmtPriceWithUsd } from "@/lib/pack-lifecycle-format"
import { packBuyLabel } from "@/lib/packs-wallet-view-format"

const ROOT = process.cwd()
const ROOTS = ["app", "components", "lib"]
const SKIP_DIRS = new Set([path.join("app", "api"), path.join("lib", "chains")])

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    const rel = path.relative(ROOT, p)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(rel) || e.name === "node_modules" || e.name.startsWith(".")) continue
      walk(p, out)
    } else if (/\.(tsx?|mdx?)$/.test(e.name) && !e.name.endsWith(".d.ts") && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/** The offending occurrences of the word DUC in one file's source: every
 *  `\bDUC\b` that is not the bare literal `"DUC"` / `'DUC'` / `` `DUC` ``. */
export function ducCopyOffenders(src: string): string[] {
  const stripped = stripComments(src).replace(/(["'`])DUC\1/g, "$1___BARE_LITERAL___$1")
  const out: string[] = []
  const lines = stripped.split("\n")
  lines.forEach((line, i) => {
    if (/\bDUC\b/.test(line)) out.push(`${i + 1}: ${line.trim()}`)
  })
  return out
}

describe("the site never says DUC (Trevor, 2026-09-25)", () => {
  const files = ROOTS.flatMap((r) => walk(path.join(ROOT, r)))

  it("inspects a real population of renderable source files", () => {
    // A walk that finds nothing has not passed, it has not spoken.
    expect(files.length).toBeGreaterThan(300)
  })

  it("no renderable source carries the word DUC outside a bare currency literal", () => {
    const offenders: string[] = []
    for (const f of files) {
      const hits = ducCopyOffenders(fs.readFileSync(f, "utf8"))
      for (const h of hits) offenders.push(`${path.relative(ROOT, f)}:${h}`)
    }
    expect(offenders).toEqual([])
  })

  it("the scanner sees the shapes the walk bans (planted defects)", () => {
    expect(ducCopyOffenders(`<span>Prices in USD (DUC)</span>`)).toHaveLength(1)
    expect(ducCopyOffenders(`const t = fmtUsd(n) + " DUC"`)).toHaveLength(1)
    expect(ducCopyOffenders("const t = `${fmtUsd(n)} DUC`")).toHaveLength(1)
    expect(ducCopyOffenders(`Prices are DUC ≈ USD.`)).toHaveLength(1)
    // …and ignores the data-value forms a formatter legitimately carries.
    expect(ducCopyOffenders(`if (c === "DUC") return fmtUsd(v)`)).toEqual([])
    expect(ducCopyOffenders(`paymentToken?: "DUC" | "FUT"`)).toEqual([])
    expect(ducCopyOffenders(`// a comment that says DUC\nconst x = 1`)).toEqual([])
    expect(ducCopyOffenders(`const DUC_CONTRACT = "0x"; let buyerDUCVault`)).toEqual([])
  })
})

describe("a dollar-pegged unit renders as plain dollars", () => {
  it("USD, DUC (any case) and an absent unit are dollar-pegged; FLOW / USDC are not", () => {
    for (const c of ["USD", "DUC", "duc", " Duc ", "", null, undefined]) expect(isUsdPegged(c)).toBe(true)
    for (const c of ["FLOW", "USDC", "FUT", "USDC_E", 12]) expect(isUsdPegged(c)).toBe(false)
  })
  it("currencySuffix is empty for a dollar-pegged unit and ' <code>' otherwise", () => {
    expect(currencySuffix("DUC")).toBe("")
    expect(currencySuffix("USD")).toBe("")
    expect(currencySuffix(null)).toBe("")
    expect(currencySuffix("FLOW")).toBe(" FLOW")
  })
  it("displayCurrency names a dollar-pegged unit USD, keeps other codes, dashes an absent one", () => {
    expect(displayCurrency("DUC")).toBe("USD")
    expect(displayCurrency("USD")).toBe("USD")
    expect(displayCurrency("USDCf")).toBe("USDCf")
    expect(displayCurrency(null)).toBe("—")
    expect(displayCurrency("")).toBe("—")
  })
  it("a 10 DUC pack shows as $10 everywhere a currency-tagged price is formatted", () => {
    expect(fmtPriceWithUsd(10, "DUC")).toBe("$10")
    expect(fmtPriceWithUsd(10, "USD")).toBe("$10")
    expect(fmtPriceWithUsd(10, "FLOW")).toBe("10 FLOW")
    expect(packBuyLabel({ has_buy: true, buy_usd: 10, buy_currency: "DUC", buy_price_source: "onchain" })).toBe("$10.00")
    expect(packBuyLabel({ has_buy: true, buy_usd: 10, buy_currency: "FLOW", buy_price_source: "onchain" })).toBe("$10.00 FLOW")
  })
})
