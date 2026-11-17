import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { walkSourceFiles, repoRelative } from "./helpers/source-files"

// Every Tailwind palette TEXT utility the app uses at a dark-theme shade, and every
// dark status-badge FILL, has a light-theme override in app/rpc-tokens.css.
//
// WHY (2026-10-18, #194 follow-up): text-emerald-400 / text-red-400 / text-amber-300 …
// are dark-theme colours; on the light canvases they read 1.2–3.5:1 (axe: Collection
// tab 651 nodes, Pack EV 2,736). The fix is a generated `[data-theme="light"]` block —
// and its own header says "a class added to the app needs a line here". This makes
// that sentence enforced: a new `text-sky-300` with no rule fails here, not in a
// light-mode visitor's eyes.

const CSS = readFileSync(join(__dirname, "..", "app", "rpc-tokens.css"), "utf8")
const HUES = "red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|yellow|amber|orange"

const TEXT_USE = new RegExp(`(?<![\\w-])((?:hover|group-hover|focus):)?text-(${HUES})-(300|400|500)(?![\\w/-])`, "g")
const FILL_USE = new RegExp(`(?<![\\w-])((?:hover|group-hover|focus):)?bg-(${HUES})-(800|900|950)(\\/\\d+)?(?![\\w-])`, "g")

function usedClasses(src: string) {
  const text = new Set<string>(), fill = new Set<string>()
  for (const m of src.matchAll(TEXT_USE)) text.add(`${m[1] ?? ""}text-${m[2]}-${m[3]}`)
  for (const m of src.matchAll(FILL_USE)) fill.add(`${m[1] ?? ""}bg-${m[2]}-${m[3]}${m[4] ?? ""}`)
  return { text, fill }
}

/** The CSS selector each class needs in the light block (Tailwind's escaping). */
function selectorFor(cls: string): string {
  const esc = cls.replace(/:/g, "\\:").replace(/\//g, "\\/")
  if (cls.startsWith("hover:")) return `[data-theme="light"] .${esc}:hover`
  if (cls.startsWith("group-hover:")) return `[data-theme="light"] .group:hover .${esc}`
  if (cls.startsWith("focus:")) return `[data-theme="light"] .${esc}:focus`
  return `[data-theme="light"] .${esc} {`
}

const FILES = ["app", "components", "lib"]
  .flatMap((r) => walkSourceFiles(r, (n) => /\.(tsx|ts)$/.test(n)))
  .map(repoRelative)
  .filter((f) => !f.startsWith("app/api/og/") && !f.startsWith("lib/og/") && !f.startsWith("lib/emails/"))

describe("Tailwind palette text + dark badge fills have a light-theme rule", () => {
  const text = new Set<string>(), fill = new Set<string>()
  for (const f of FILES) {
    const u = usedClasses(readFileSync(f, "utf8"))
    u.text.forEach((c) => text.add(c)); u.fill.forEach((c) => fill.add(c))
  }

  it("walks a real population (not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(500)
    expect(text.size).toBeGreaterThan(20)
    expect(fill.size).toBeGreaterThan(10)
  })

  it("every used text-<hue>-300/400/500 class has a light override", () => {
    const missing = [...text].filter((c) => !CSS.includes(selectorFor(c)))
    expect(missing, "regenerate the LIGHT THEME — Tailwind palette TEXT utilities block in app/rpc-tokens.css").toEqual([])
  })

  it("every used dark badge fill bg-<hue>-800/900/950 has a light override", () => {
    const missing = [...fill].filter((c) => !CSS.includes(selectorFor(c)))
    expect(missing, "add it to the Status-badge FILLS block in app/rpc-tokens.css").toEqual([])
  })
})

describe("the detector is not vacuous", () => {
  it("finds plain and variant text classes and badge fills, and ignores other utilities", () => {
    const u = usedClasses(`<b className="text-sky-300 hover:text-teal-400 bg-emerald-900/40 bg-red-950 text-zinc-300 text-sky-200 border-emerald-700 text-red-400/60" />`)
    expect([...u.text].sort()).toEqual(["hover:text-teal-400", "text-sky-300"])
    expect([...u.fill].sort()).toEqual(["bg-emerald-900/40", "bg-red-950"])
  })
  it("a planted unknown class would be reported missing", () => {
    expect(CSS.includes(selectorFor("text-lime-300"))).toBe(false)
  })
})
