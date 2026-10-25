import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { walkSourceFiles } from "./helpers/source-files"
import { scrollRegion } from "@/lib/a11y/scroll-region"

// Every `.rpc-scroll-x` container must be a focusable, NAMED region
// (lib/a11y/scroll-region.ts). 2026-10-25: axe read `scrollable-region-focusable`
// (serious) on the live edition and player pages at phone width — 16 such
// containers site-wide, none focusable. A tree walk, so a new one is covered the
// day it lands.

const FILES = ["app", "components"].flatMap((root) => walkSourceFiles(root, (n) => n.endsWith(".tsx")))

function offenders(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/<[a-z]+\b[^>]*className="[^"]*\brpc-scroll-x\b[^"]*"[^>]*>/g)) {
    const tag = m[0]
    if (!/\{\.\.\.scrollRegion\("[^"]{3,}"\)\}/.test(tag)) out.push(tag.slice(0, 120))
  }
  return out
}

describe("horizontally scrollable containers are keyboard-reachable", () => {
  it("the walk sees the containers (not vacuous)", () => {
    const n = FILES.reduce((k, f) => k + (readFileSync(f, "utf8").match(/className="[^"]*\brpc-scroll-x\b/g)?.length ?? 0), 0)
    expect(n).toBeGreaterThanOrEqual(10)
  })

  it("every .rpc-scroll-x spreads scrollRegion(<label>)", () => {
    const bad = FILES.flatMap((f) => offenders(readFileSync(f, "utf8")).map((t) => `${f}: ${t}`))
    expect(bad).toEqual([])
  })

  it("detects a bare container (planted control)", () => {
    expect(offenders('<div className="rpc-scroll-x">')).toHaveLength(1)
    expect(offenders('<div className="rpc-scroll-x" {...scrollRegion("Recent sales")}>')).toHaveLength(0)
  })

  it("scrollRegion returns a focusable named region", () => {
    expect(scrollRegion("Recent sales")).toEqual({ tabIndex: 0, role: "region", "aria-label": "Recent sales" })
  })
})
