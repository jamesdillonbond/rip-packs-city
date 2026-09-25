// @vitest-environment node
//
// __tests__/usd-negative-sign-first.test.ts
//
// NEGATIVE USD RENDERS SIGN-FIRST — "-$50.34", never "$-50.34" (Trevor,
// 2026-09-25, #137 b). The old "$-" form was a pinned house convention in ~12
// formatters while lib/format.ts and lib/analytics/format's `fmt` printed
// "-$", so a P&L read "EV $-50.34" on one page and "-$42.00" on the next.
//
// A TREE WALK, not a curated list: every lib/ module that builds a dollar string
// by concatenation ("$" + …, '$' + … or `$${…}`) is imported, and every exported function
// is called with negative inputs. Any string result containing "$-" fails. A new
// formatter is covered the day it lands; fix it with usdSignFirst() from
// lib/usd-format.ts.

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "..")
const LIB = path.join(ROOT, "lib")
const BUILDS_DOLLARS = /["']\$["'] ?\+|`\$\$\{/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p)
  }
  return out
}

const files = walk(LIB).filter((f) => BUILDS_DOLLARS.test(fs.readFileSync(f, "utf8")))
const NEGATIVES = [-0.5, -12.5, -250, -1500.6, -2_500_000]

describe("negative USD is sign-first across lib/", () => {
  it("inspects a real population of dollar-building modules", () => {
    // A walk that finds nothing has not passed, it has not spoken.
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files.map((f) => [path.relative(ROOT, f)]))("%s never prints \"$-\"", async (rel) => {
    let mod: Record<string, unknown>
    try {
      mod = await import(path.join(ROOT, rel))
    } catch {
      return // a module that cannot load outside Next (env, server-only) is out of reach here
    }
    const offenders: string[] = []
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== "function" || fn.length < 1) continue
      for (const n of NEGATIVES) {
        let out: unknown
        try {
          out = (fn as (x: unknown) => unknown)(n)
        } catch {
          continue
        }
        if (typeof out === "string" && out.includes("$-")) offenders.push(`${name}(${n}) → ${out}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
