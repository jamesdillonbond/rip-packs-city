import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { collectionLayoutMetadata, editionPageMetadata, setPageMetadata, rootMetadata } from "@/lib/seo"

// deep-audit D24: 29 layouts baked " | Rip Packs City" into their `title`, but
// the root metadata template in lib/seo.ts is '%s | Rip Packs City', so every
// one of them rendered "… | Rip Packs City | Rip Packs City" — all indexable.
//
// ⚠⚠ THE FIRST VERSION OF THIS GUARD WAS BLIND THREE WAYS AND THE DEFECT IT WAS
// NAMED TO PREVENT STAYED LIVE FOR WEEKS. Measured in production 2026-08-23:
//
//   /about                     "About — Rip Packs City | Rip Packs City"
//   /blog                      "Blog — Rip Packs City | Rip Packs City"
//   /privacy                   "Privacy Policy — Rip Packs City | Rip Packs City"
//   /legal/fmv-methodology     "FMV Methodology — Rip Packs City | Rip Packs City"
//   /disney-pinnacle/collection "Disney Pinnacle Analytics — Rip Packs City | Rip Packs City"
//   /nba-top-shot/pack-sniper  "NBA Top Shot Analytics — Rip Packs City | Rip Packs City"
//
// The three blind spots, each of which is now closed:
//   1. It matched only the PIPE spelling. Every live offender used an EM DASH.
//   2. It matched only DOUBLE-QUOTED literals. lib/seo.ts uses single quotes and
//      the entity builders use backticks.
//   3. It walked `app/` only, and the collection-wide title lives in `lib/seo.ts`.
// This is the documented shape: coverage is only real against what the guard
// READS, and a guard's declared scope is itself a measurement.
//
// The SECOND property here is deep-audit R31, which is the same line's opposite
// failure. A segment that sets a plain-string `title` is formatted by the
// nearest ANCESTOR template and contributes NO template of its own, so an
// intermediate layout with a string title silently strips the brand from every
// descendant. Measured: /insights/first-mint rendered "Top Shot First-Mint
// Trophy Tracker" flat and /nba-top-shot/collection rendered "Wallet Analytics —
// Track Your NBA Top Shot Collection Value" flat, while /insights and / — both
// one level down, formatted by the ROOT template — looked perfect. That is why
// it read as fine for so long: the pages a human spot-checks are the two the
// bug cannot reach.
//
// Directory-driven: a new layout is covered the day it lands.

const APP = join(process.cwd(), "app")
// The suffix form only. "Public API — Programmatic Access to Rip Packs City
// Analytics" mentions the brand mid-sentence and is not this defect; banning it
// would be a rule with no failure behind it.
const BRAND_SUFFIX = /\s+[—|]\s+Rip Packs City$/
const NESTED_TITLE_OWNERS = new Set(["openGraph", "twitter"])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry === "layout.tsx" || entry === "page.tsx" || entry === "not-found.tsx") out.push(full)
  }
  return out
}

const FILES = walk(APP).map((path) => ({
  path: path.replace(/\\/g, "/").replace(`${process.cwd().replace(/\\/g, "/")}/`, ""),
  src: readFileSync(path, "utf8"),
}))

const indentOf = (line: string) => line.length - line.trimStart().length

/** The key of the nearest enclosing `<key>: {` at a shallower indent, if any. */
function titleOwner(lines: string[], i: number): string | null {
  const ind = indentOf(lines[i])
  for (let j = i - 1; j >= 0; j--) {
    const p = lines[j]
    if (!p.trim()) continue
    if (indentOf(p) < ind) {
      const m = p.trim().match(/^(\w+):\s*\{$/)
      return m ? m[1] : null
    }
  }
  return null
}

type Hit = { path: string; value: string }

function bareBrandSuffixedTitles(): { hits: Hit[]; literalsInspected: number } {
  const hits: Hit[] = []
  let literalsInspected = 0
  for (const { path, src } of FILES) {
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t.startsWith("//") || t.startsWith("*")) continue
      // `title: { absolute: … }` is the sanctioned opt-out: `absolute` REPLACES
      // the template rather than feeding it, so the brand appears exactly once.
      if (t.includes("absolute:")) continue
      // All three quote styles, plus the single-line `return { title: … }`
      // early-out that several generateMetadata functions use.
      const own = t.match(/^title:\s*(["'`])(.*?)\1,?$/)
      const ret = t.match(/return \{ title: (["'`])(.*?)\1 \}/)
      const m = own ?? ret
      if (!m) continue
      literalsInspected++
      if (own && NESTED_TITLE_OWNERS.has(titleOwner(lines, i) ?? "")) continue
      if (BRAND_SUFFIX.test(m[2])) hits.push({ path, value: m[2] })
    }
  }
  return { hits, literalsInspected }
}

describe("no metadata title double-suffixes the brand", () => {
  it("found layouts/pages to scan, and title literals inside them", () => {
    // Positive control, both levels — a broken walker OR a broken matcher would
    // make every assertion below vacuous, and the two fail differently.
    expect(FILES.length).toBeGreaterThan(50)
    expect(bareBrandSuffixedTitles().literalsInspected).toBeGreaterThan(50)
  })

  it("no bare metadata `title` bakes in the brand the template already appends", () => {
    // Ban at population zero, in every quote style and both separators.
    const { hits } = bareBrandSuffixedTitles()
    expect(hits.map((h) => `${h.path}: ${h.value}`)).toEqual([])
  })

  it("the sanctioned `absolute` opt-out is still allowed", () => {
    // Guards against someone "fixing" the rule above by deleting the brand from
    // the pages that legitimately set a fully-formed title via `absolute`.
    const absolutes = FILES.filter((f) => /title: \{ absolute:/.test(f.src))
    expect(absolutes.length).toBeGreaterThan(0)
  })
})

describe("intermediate layouts re-declare the brand template (R31)", () => {
  it("collectionLayoutMetadata carries BOTH absolute and template", () => {
    // Both halves fix opposite defects on the same line. Dropping `template`
    // strips the brand from the whole /<collection>/* subtree; dropping
    // `absolute` double-suffixes the collection's own landing page. A test that
    // asserted only one of them would pass through half the bug.
    for (const id of ["nba-top-shot", "nfl-all-day", "laliga-golazos", "disney-pinnacle", "ufc", "not-a-collection"]) {
      const title = collectionLayoutMetadata(id).title as { absolute?: string; template?: string }
      expect(typeof title, `${id} must set a title OBJECT, not a string`).toBe("object")
      expect(title.template, `${id} must re-declare the template for its subtree`).toBe(
        rootMetadata.title && typeof rootMetadata.title === "object"
          ? (rootMetadata.title as { template?: string }).template
          : undefined
      )
      expect(title.absolute, `${id} must not feed its own branded title to the template`).toBeTruthy()
      expect(String(title.absolute)).not.toMatch(/Rip Packs City.*Rip Packs City/)
    }
  })

  // 2026-11-06: the curated check below (insights only) is now a TREE WALK —
  // /trades/layout.tsx had a string title, so the PUBLIC, indexable
  // /trades/block pages rendered "<title>Trade Block</title>" with no brand, and
  // the guard could not see it. Rule: a layout that sets a title AND has any
  // descendant page/layout that sets its own title must carry a template.
  it("every non-leaf layout that sets a title re-declares the template (tree walk)", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p, out)
        else if (/\.(tsx|ts)$/.test(ent.name) && !/Client\.tsx$/.test(ent.name)) out.push(p)
      }
      return out
    }
    const all = walk(APP)
    const setsTitle = (src: string) => /(^|[\s{,])title:\s*["'`{]/m.test(src) || /title:\s*[A-Z_]+\b/.test(src)
    const layouts = all.filter((p) => /[\\/]layout\.tsx$/.test(p))
    const offenders: string[] = []
    let nonLeaf = 0
    for (const lay of layouts) {
      const src = readFileSync(lay, "utf8")
      if (!setsTitle(src)) continue
      const dir = lay.slice(0, -"layout.tsx".length)
      // A descendant whose every title is `{ absolute: … }` never reads the
      // template, so it does not make this layout non-leaf (profile/[username]
      // and its trophy-case layout are that shape).
      const needsTemplate = (src: string) => {
        const stripped = src.replace(/title:\s*\{\s*absolute:[^}]*\}/g, "")
        return setsTitle(stripped)
      }
      const descendants = all.filter((p) => p !== lay && p.startsWith(dir) && needsTemplate(readFileSync(p, "utf8")))
      if (descendants.length === 0) continue
      nonLeaf++
      const m = src.match(/title:\s*\{[^}]*\}/)
      if (!m || !m[0].includes("template")) offenders.push(lay.slice(APP.length))
    }
    expect(nonLeaf, "the walk must find the known non-leaf layouts (insights, trades, dashboard)").toBeGreaterThanOrEqual(3)
    expect(offenders).toEqual([])
  })

  it("app/insights/layout.tsx re-declares the template", () => {
    const src = readFileSync(join(APP, "insights", "layout.tsx"), "utf8")
    // Pin the PROPERTY, not the spelling: the title must be an object carrying a
    // template, however it is written.
    const m = src.match(/title:\s*\{[^}]*\}/)
    expect(m, "insights layout must set a title object").not.toBeNull()
    expect(m![0]).toContain("template")
  })

  it("entity metadata is absolute, so restoring the template cannot double-brand the ~33k-URL corpus", () => {
    // These builders bake "| Rip Packs City" into a fully-formed title. Before
    // R31 that was invisible because no template reached them; the moment
    // collectionLayoutMetadata re-declared one, a bare string here would have
    // suffixed every entity page in the sitemap a second time.
    const edition = editionPageMetadata({ player_name: "Test Player", set_name: "Test Set" } as never, "nba-top-shot")
    const set = setPageMetadata({ set_name: "Test Set" } as never, "test-set", "nba-top-shot")
    for (const [name, meta] of [["edition", edition], ["set", set]] as const) {
      const title = meta.title as { absolute?: string }
      expect(typeof title, `${name} title must be an object`).toBe("object")
      expect(title.absolute, `${name} must use absolute`).toContain("Rip Packs City")
    }
  })
})
