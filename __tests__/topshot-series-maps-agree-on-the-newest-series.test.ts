import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Top Shot's series → label map is duplicated across ~10 files (routes, SEO,
// analytics, filter params). When a new series mints, every copy must learn it
// together, or the same edition reads "Series 2026-27" on one page and
// "Unknown" / "Series 9" on another. Pinned 2026-10-15 ahead of Series 2026-27:
// every source file that names "Series 2025-26" as a MAP ENTRY must also carry
// "2026-27". (Prose mentions — comments, prompt text — are not map entries.)

const ROOTS = ["app", "lib", "components"]
const SKIP = new Set(["node_modules", ".next", "__tests__"])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// A map entry: `8: "Series 2025-26"`, `"8": "Series 2025-26"`, `"Series 2025-26": 8`,
// `"Series 2025-26": "8"`, or `8: "2025-26"` / `8: "25-26 · 2025-26"`.
const ENTRY = /(["']?8["']?\s*:\s*["'][^"'\n]*2025-26["'])|(["']Series 2025-26["']\s*:\s*["']?8["']?)/

const codeOnly = (src: string): string => stripComments(src)

describe("Top Shot series maps carry the newest series together", () => {
  const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r)))
  const withEntry = files.filter((f) => ENTRY.test(codeOnly(readFileSync(f, "utf8"))))

  it("finds the maps it is guarding (not vacuous)", () => {
    expect(withEntry.length).toBeGreaterThanOrEqual(8)
  })

  it.each(withEntry.map((f) => [f.replace(process.cwd() + "/", "")]))("%s also labels Series 2026-27", (rel) => {
    const src = codeOnly(readFileSync(join(process.cwd(), rel), "utf8"))
    expect(src).toMatch(/2026-27/)
  })

  it("control: the entry pattern matches each map shape and not prose", () => {
    expect(ENTRY.test(`  8: "Series 2025-26",`)).toBe(true)
    expect(ENTRY.test(`  "8": "Series 2025-26",`)).toBe(true)
    expect(ENTRY.test(`  "Series 2025-26": "8",`)).toBe(true)
    expect(ENTRY.test(`  "Series 2025-26": 8,`)).toBe(true)
    expect(ENTRY.test(`4: "2021-22", 8: "2025-26",`)).toBe(true)
    expect(ENTRY.test(`  8: "25-26 · 2025-26",`)).toBe(true)
    expect(ENTRY.test(`the 2023-24 / 2024-25 / 2025-26 seasons`)).toBe(false)
  })
})
