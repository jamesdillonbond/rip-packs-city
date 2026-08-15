import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"

// The FIFTH honesty layer — link-preview metadata — and the only one of the five
// that had no directory-driven guard.
//
// The rule (CLAUDE.md, "A failed read must not render as an answer"): a
// `generateMetadata` must never emit a figure the read did not produce, and must
// never let a FAILED read masquerade as ABSENCE. /moment/[id] is the canonical
// shape — it destructures `ok` and answers "Not Found" only for an answered read,
// "Unavailable" + noindex,follow for a failed one.
//
// ⚠ WHY A GUARD AND NOT JUST TWO FIXES. Found 2026-08-15 on BOTH pack pages, and
// in each the page BODY already made the distinction while `generateMetadata`
// dropped it — same file, same distinction, fixed in one function and not the
// other. `/[collection]/pack/dist/[distId]` is the surface with the platform's
// highest timeout count (Sentry NEXTJS-1Z, 86 users), and metadata reads its OWN
// rows rather than the body's bundle, so the metadata read can fail while the
// page renders perfectly — a real, working pack page with no title, no canonical
// and no OG image, still indexable. That is invisible in a browser and only ever
// seen in someone else's timeline, which is exactly why it survived.
//
// This layer is also where the false "Portfolio: $0 FMV across 0 moments" lived
// on /profile/[username] for ~2 months.

/** Files declaring a fetcher whose result carries an `ok` flag. */
function okCarryingTypeNames(): Set<string> {
  // Derived, not hand-listed: any interface/type in the repo whose body declares
  // `ok: boolean` makes every function returning it an ok-carrying fetcher.
  const out = new Set<string>(["RowResult", "RowsResult"])
  const files = execSync(
    "grep -rl 'ok: boolean' lib app --include=*.ts --include=*.tsx || true",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    for (const m of src.matchAll(/(?:interface|type)\s+(\w+)(?:<[^>]*>)?\s*=?\s*\{([^}]*)\}/g)) {
      if (/\bok\s*\??\s*:\s*boolean/.test(m[2])) out.add(m[1])
    }
  }
  return out
}

/** Every function name whose declared return type carries an `ok` flag. */
function okCarryingFetchers(okTypes: Set<string>): Set<string> {
  const names = new Set<string>()
  const files = execSync(
    "grep -rl 'function ' lib app --include=*.ts --include=*.tsx || true",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
  const typeAlt = Array.from(okTypes).join("|")
  // ⚠ Scanned in a BOUNDED WINDOW per declaration, not with one whole-file
  // regex. A `\([\s\S]*?\)` for the parameter list backtracks ACROSS function
  // boundaries when the nearest declaration has no matching return type — one
  // match then swallows several functions and reports the wrong name, which is
  // how the first version of this guard silently discovered 1 fetcher instead
  // of dozens and still passed its own coverage assertions.
  const returnsOk = new RegExp(
    String.raw`\)\s*:\s*Promise<\s*(?:(?:${typeAlt})\b|\{[^}]*\bok\s*\??\s*:\s*boolean)`,
  )
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    for (const m of src.matchAll(/function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
      const window = src.slice(m.index, m.index + 600)
      if (returnsOk.test(window)) names.add(m[1])
    }
  }
  return names
}

/** Extract each file's `generateMetadata` body by brace matching. */
function generateMetadataBody(src: string): string | null {
  const start = src.search(/export\s+(?:async\s+)?function\s+generateMetadata\b/)
  if (start < 0) return null
  // ⚠ NOT `indexOf("{", start)` — the parameter list is itself an object
  // pattern with an inline type (`{ params }: { params: Promise<{...}> }`), so
  // the first brace after the name belongs to the params, not the body. Walk the
  // PARENS to their close first, then take the next brace.
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
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

function stripComments(s: string): string {
  // Required, not tidiness: the comments this guard's own fixes added NAME the
  // fetchers involved. This repo has tripped that trap four times.
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

const metadataFiles = execSync(
  "grep -rl 'export async function generateMetadata\\|export function generateMetadata' app --include=*.tsx --include=*.ts || true",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)

describe("generateMetadata — a failed read must not be published as absence", () => {
  const okTypes = okCarryingTypeNames()
  const fetchers = okCarryingFetchers(okTypes)

  it("is not vacuous: it discovered the ok-carrying types, fetchers and metadata files", () => {
    expect(okTypes.has("RowResult")).toBe(true)
    // The canonical example and the two that were broken must all be discovered.
    expect(fetchers.has("fetchPackRow")).toBe(true)
    expect(fetchers.has("fetchLifecycle")).toBe(true)
    expect(metadataFiles.length).toBeGreaterThan(20)
  })

  it("every generateMetadata that calls an ok-carrying fetcher reads its ok", () => {
    const offenders: string[] = []
    for (const file of metadataFiles) {
      const body = generateMetadataBody(readFileSync(file, "utf8"))
      if (!body) continue
      const code = stripComments(body)
      const called = Array.from(fetchers).filter((fn) =>
        new RegExp(String.raw`\b${fn}\s*\(`).test(code),
      )
      if (called.length === 0) continue
      // Reading `ok` in any form counts: `ok:`, `.ok`, `okSomething`.
      if (!/\bok\b/.test(code)) offenders.push(`${file} (calls ${called.join(", ")})`)
    }
    expect(offenders, `generateMetadata discards the ok flag in:\n${offenders.join("\n")}`).toEqual([])
  })

  it("the two pack pages branch on the failed read with noindex,follow", () => {
    // Pinned concretely, because the generic check above only proves `ok` is
    // MENTIONED. These are the instances the guard was written for.
    for (const file of [
      "app/(collections)/[collection]/pack/dist/[distId]/page.tsx",
      "app/(collections)/[collection]/pack/[id]/page.tsx",
    ]) {
      const code = stripComments(generateMetadataBody(readFileSync(file, "utf8")) ?? "")
      expect(code, `${file} must withhold indexing on a failed metadata read`).toMatch(
        /index:\s*false[\s\S]{0,40}follow:\s*true/,
      )
      expect(code, `${file} must say unavailable, not absent`).toMatch(/Unavailable/i)
    }
  })

  it("a failed read never claims not-found, on any metadata surface", () => {
    // The inverse of the rule: "Not Found" copy may only sit on a branch that
    // knows the read succeeded. Any file using both must reference ok between
    // them — checked structurally rather than by wording, since each page words
    // its own absence differently.
    const offenders: string[] = []
    for (const file of metadataFiles) {
      const code = stripComments(generateMetadataBody(readFileSync(file, "utf8")) ?? "")
      if (!/not\s*found/i.test(code)) continue
      const called = Array.from(fetchers).filter((fn) =>
        new RegExp(String.raw`\b${fn}\s*\(`).test(code),
      )
      if (called.length > 0 && !/\bok\b/.test(code)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
