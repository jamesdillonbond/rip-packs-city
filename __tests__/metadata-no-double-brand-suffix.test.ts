import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// deep-audit D24: 29 layouts baked " | Rip Packs City" into their `title`, but
// the root metadata template in lib/seo.ts is '%s | Rip Packs City', so every
// one of them rendered "… | Rip Packs City | Rip Packs City" — all indexable.
//
// The two newest boards (candy-mlb, panini-squeeze) had already worked around it
// with `title: { absolute: … }` and documented the bug in a comment, so it was
// known and unfixed while the broken form quietly became the majority.
//
// Directory-driven: a new layout is covered the day it lands.

const APP = join(process.cwd(), "app")
const SUFFIX = "| Rip Packs City"

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry === "layout.tsx" || entry === "page.tsx") out.push(full)
  }
  return out
}

const FILES = walk(APP).map((path) => ({
  path: path.replace(/\\/g, "/").replace(`${process.cwd().replace(/\\/g, "/")}/`, ""),
  src: readFileSync(path, "utf8"),
}))

describe("no metadata title double-suffixes the brand", () => {
  it("found layouts/pages to scan", () => {
    // Positive control — a broken walker would make every assertion vacuous.
    expect(FILES.length).toBeGreaterThan(50)
  })

  it("no bare `title:` string bakes in the brand the template already appends", () => {
    const offenders: string[] = []
    for (const { path, src } of FILES) {
      for (const line of src.split(/\r?\n/)) {
        const t = line.trim()
        if (t.startsWith("//") || t.startsWith("*")) continue
        // `title: { absolute: "… | Rip Packs City" }` is the sanctioned opt-out:
        // `absolute` REPLACES the template rather than feeding it, so the brand
        // appears exactly once. Only the bare string form is a defect.
        const m = t.match(/^title: "(.*)",?$/)
        if (m && m[1].includes(SUFFIX)) offenders.push(`${path}: ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("the sanctioned `absolute` opt-out is still allowed", () => {
    // Guards against someone "fixing" this by deleting the brand from the two
    // boards that legitimately set it via `absolute`.
    const absolutes = FILES.filter((f) => /title: \{ absolute:/.test(f.src))
    expect(absolutes.length).toBeGreaterThan(0)
  })
})
