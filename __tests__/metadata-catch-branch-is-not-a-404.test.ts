import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// The link-preview honesty layer, from the side its existing guard cannot see.
//
// ── WHAT metadata-failed-read-vs-absent-guard ALREADY COVERS ────────────────
// That guard is good and directory-driven, but it fires only on a
// `generateMetadata` body that calls an **ok-carrying fetcher** — a function
// whose declared return type has an `ok: boolean`. That is how the pack pages
// report a failed read, so those are covered.
//
// ── WHAT IT IS SILENT ABOUT, BY CONSTRUCTION ────────────────────────────────
// The five SEO entity pages don't use that shape at all. Their `fetchDetail`
// returns `T | null` and **throws** on an RPC error (deep-audit D10), so they
// carry no `ok` anywhere and the existing guard skips them — however often it
// runs green. Same guard-scope class CLAUDE.md records for the anon
// driver-message guard and `insights-gate-include-completeness`: deriving a
// guard's inputs from a predicate fixes its scope to that predicate.
//
// Verified 2026-08-15 by mutation: changing `/[collection]/set/[slug]`'s
// `generateMetadata` catch from a generic non-404 title to `NOT_FOUND_METADATA`
// — one line — passed `tsc` and the full 11,958-test suite green. That mutation
// tells Google a real set page does not exist, on a transient pool blip.
// ~20,500 sitemap URLs sit on these five routes.
//
// ── THE RULE, AND WHY IT IS ABOUT `follow`, NOT `index` ─────────────────────
// The repo already uses two distinct robots vocabularies, and the distinction is
// the whole finding:
//
//   index:false, follow:FALSE  →  "this does not exist / is private"  (4 sites)
//   index:false, follow:TRUE   →  "we could not read it right now"    (10 sites)
//
// `follow:false` is the destructive half: it invites the crawler to drop the
// page AND stop following its links. A failed read may legitimately withhold
// indexing for that fetch — it must never claim absence. So the rule is
// spelling-independent: **no failure branch may emit a follow:false robots
// directive**, whether written inline or via NOT_FOUND_METADATA.
//
// This does NOT require a catch. A `generateMetadata` with no catch at all is
// correct too (edition/series let the throw reach the error boundary) — the
// guard only constrains what a catch is allowed to return.

/** Bodies are located by brace matching, not by a fixed window. */
function generateMetadataBody(src: string): string | null {
  const start = src.search(/export\s+(?:async\s+)?function\s+generateMetadata\b/)
  if (start < 0) return null
  // ⚠ NOT `indexOf("{", start)` — the parameter list is itself an object
  // pattern with an inline type, so the first brace belongs to the params.
  // Walk the PARENS closed first, then take the next brace.
  let paren = 0
  let i = src.indexOf("(", start)
  if (i < 0) return null
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++
    else if (src[i] === ")") {
      paren--
      if (paren === 0) break
    }
  }
  const open = src.indexOf("{", i)
  if (open < 0) return null
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++
    else if (src[j] === "}") {
      depth--
      if (depth === 0) return src.slice(open, j + 1)
    }
  }
  return null
}

/** Every `catch { ... }` / `catch (e) { ... }` block in a body, brace-matched. */
function catchBlocks(body: string): string[] {
  const out: string[] = []
  const re = /\bcatch\s*(?:\([^)]*\)\s*)?\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const open = body.indexOf("{", m.index)
    let depth = 0
    for (let j = open; j < body.length; j++) {
      if (body[j] === "{") depth++
      else if (body[j] === "}") {
        depth--
        if (depth === 0) {
          out.push(body.slice(open, j + 1))
          break
        }
      }
    }
  }
  return out
}

/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

const metadataFiles = execSync(
  "grep -rl 'export async function generateMetadata\\|export function generateMetadata' app --include=*.tsx --include=*.ts || true",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)

/** Files whose generateMetadata catches at all — the population under test. */
const filesWithCatch = metadataFiles.filter((f) => {
  const body = generateMetadataBody(readFileSync(f, "utf8"))
  return body ? catchBlocks(stripComments(body)).length > 0 : false
})

// The three entity pages that catch. Named so the guard reds if one stops
// catching AND stops being discovered — a silent way to leave the population.
const ENTITY_CATCH_PAGES = [
  "app/(collections)/[collection]/team/[slug]/page.tsx",
  "app/(collections)/[collection]/player/[slug]/page.tsx",
  "app/(collections)/[collection]/set/[slug]/page.tsx",
]

describe("generateMetadata — a caught failure must never be published as absence", () => {
  it("is not vacuous: it found the metadata files and the catching subset", () => {
    expect(metadataFiles.length).toBeGreaterThan(25)
    expect(filesWithCatch.length).toBeGreaterThan(0)
    for (const p of ENTITY_CATCH_PAGES) {
      expect(filesWithCatch, `${p} must still be discovered as a catching site`).toContain(p)
    }
  })

  it("no catch branch returns NOT_FOUND_METADATA", () => {
    const offenders: string[] = []
    for (const file of filesWithCatch) {
      const body = generateMetadataBody(readFileSync(file, "utf8"))!
      for (const block of catchBlocks(stripComments(body))) {
        if (/\bNOT_FOUND_METADATA\b/.test(block)) offenders.push(file)
      }
    }
    expect(
      offenders,
      "a failed metadata read must not claim the page does not exist:\n" + offenders.join("\n"),
    ).toEqual([])
  })

  it("no catch branch emits a follow:false robots directive", () => {
    // The spelling-independent form of the rule above — an inline
    // `robots: { index: false, follow: false }` is the same lie without the
    // constant, and a grep for the constant alone would miss it.
    const offenders: string[] = []
    for (const file of filesWithCatch) {
      const body = generateMetadataBody(readFileSync(file, "utf8"))!
      for (const block of catchBlocks(stripComments(body))) {
        if (/follow:\s*false/.test(block)) offenders.push(file)
      }
    }
    expect(
      offenders,
      "a failed read may withhold indexing, but must keep follow:true:\n" + offenders.join("\n"),
    ).toEqual([])
  })

  it("each entity catch still emits a real, non-empty title", () => {
    // The inverse. Returning `{}` from the catch is not a 404, but it drops the
    // page to the site's generic metadata — an unfurl with no identity. The
    // three pages answer with a slug-derived title, which is the minimum honest
    // output when the read failed.
    for (const file of ENTITY_CATCH_PAGES) {
      const body = generateMetadataBody(readFileSync(file, "utf8"))!
      const blocks = catchBlocks(stripComments(body))
      expect(blocks.length, `${file} must catch its detail fetch`).toBeGreaterThan(0)
      const joined = blocks.join("\n")
      expect(joined, `${file} catch must return a titled Metadata`).toMatch(/title:/)
    }
  })
})

describe("the two robots vocabularies stay distinct", () => {
  // If these ever collapse into one constant, every guard above is satisfiable
  // while the distinction they protect is gone.
  const seo = readFileSync("lib/seo.ts", "utf8")

  it("NOT_FOUND_METADATA means ABSENT: index:false, follow:false", () => {
    const m = seo.match(/export const NOT_FOUND_METADATA[\s\S]{0,220}?\n\}/)
    expect(m, "NOT_FOUND_METADATA must still be defined in lib/seo.ts").toBeTruthy()
    expect(m![0]).toMatch(/index:\s*false/)
    expect(m![0]).toMatch(/follow:\s*false/)
  })

  it("the unavailable shape means COULD-NOT-READ: index:false, follow:true", () => {
    // Pinned on the two pack pages, which is where this vocabulary was
    // established (they are also covered by the ok-carrying guard; this asserts
    // the WORDING of the directive rather than the presence of an ok flag).
    for (const file of [
      "app/(collections)/[collection]/pack/dist/[distId]/page.tsx",
      "app/(collections)/[collection]/pack/[id]/page.tsx",
    ]) {
      const body = stripComments(generateMetadataBody(readFileSync(file, "utf8")) ?? "")
      expect(body, `${file} must keep follow:true on its failed-read branch`).toMatch(
        /index:\s*false[\s\S]{0,60}follow:\s*true/,
      )
    }
  })
})
