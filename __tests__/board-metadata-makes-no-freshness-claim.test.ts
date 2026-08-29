import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// ── Structured data cannot be conditioned, so a freshness claim there is always a lie
//
// 🚨 WHY THIS EXISTS (2026-08-29). "Refreshes continuously" was retired from the
// deals board's visible copy in the morning and from the bid-vs-floor board's in the
// evening, each pinned by a component test asserting the ABSENCE of the claim. Both
// went green. Then the DEPLOYED HTML was fetched and the phrase was still in the
// document — TWICE — because it also lives in each board's sibling `layout.tsx`, in
// the JSON-LD `description` and the route metadata. Six copies of one sentence; the
// component tests could not see two of them, because a component test cannot see a
// sibling layout. **"The page no longer says it" was true of the page and false of
// the document.**
//
// ⛔ AND THE LAYOUT IS THE WORST PLACE FOR IT. Visible copy can be derived from the
// rows on screen — that is exactly what both boards now do, showing the steady-state
// sentence only when the rows support it. Static metadata and JSON-LD are emitted
// before any row is known and are read by MACHINES, so a freshness claim there is
// unconditional by construction: it cannot be falsified, cannot be withdrawn when the
// feed dies, and is asserted to search engines as a fact about the product. On the day
// this landed, `offers-sweep` had not confirmed an ask in over 30 hours.
//
// ⚠ THIS GUARD READS STRING LITERALS, NOT STRIPPED SOURCE. The fix's own comments
// quote the banned sentence to explain why it was wrong, and this repo has had guards
// fire on the comment documenting the fix at least six times — plus `stripComments`
// itself has been measured blind three times. A `description:` value cannot be a
// comment, so extracting the literal sidesteps the whole problem rather than relying
// on a stripper being right.

const ROOT = path.resolve(__dirname, "..")

/** Every phrase that asserts the DATA is current, as a property rather than a spelling. */
const FRESHNESS_CLAIMS: RegExp[] = [
  /refreshe?s?\s+continuously/i,
  /updates?\s+continuously/i,
  /updated\s+continuously/i,
  /continuous(ly)?\s+(?:updated|refreshed|ingested)/i,
  /always\s+up[\s-]?to[\s-]?date/i,
  /real[\s-]?time\s+data/i,
  /up[\s-]to[\s-]the[\s-]minute/i,
  /\blive\s+prices?\b/i,
]

function walk(dir: string): string[] {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const full = path.join(dir, e)
    if (statSync(full).isDirectory()) out = out.concat(walk(full))
    else if (e === "layout.tsx") out.push(full)
  }
  return out
}

/**
 * Pull every `description: "…"` / `description:\n  "…"` string literal out of a file.
 * Covers both the Next `metadata` export and the JSON-LD object, which are the two
 * places a board's machine-readable summary can live.
 */
function descriptions(src: string): string[] {
  const out: string[] = []
  const re = /\bdescription\s*:\s*(?:\r?\n\s*)?(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[2])
  return out
}

const LAYOUTS = walk(path.join(ROOT, "app"))

describe("board metadata and JSON-LD make no unconditional freshness claim", () => {
  it("is not vacuous: the walk finds layouts, and they carry descriptions", () => {
    // ⚠ Asserts on the WALK and on the EXTRACTOR, never on a dirty count — the
    // assertion has to stay satisfiable at a population of zero, which is the goal.
    // Without the second half, a broken `descriptions()` regex would leave the ban
    // below passing forever while reading nothing.
    expect(LAYOUTS.length).toBeGreaterThan(5)
    const withDesc = LAYOUTS.filter((f) => descriptions(readFileSync(f, "utf8")).length > 0)
    expect(withDesc.length).toBeGreaterThan(2)
  })

  it("guards-the-guard: the extractor finds a description a COMMENT would hide", () => {
    // The exact shape that defeated the last attempt — the banned phrase present in
    // both a comment and a live literal. Only the literal may be reported.
    const sample = `
      // ⚠ this used to say "Refreshes continuously." and that was wrong
      export const metadata = {
        description:
          "Ranks editions by discount. Refreshes continuously.",
      }
    `
    const found = descriptions(sample)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/Refreshes continuously/)
  })

  it("guards-the-guard: every banned phrase actually matches the copy it was written for", () => {
    const samples = [
      "Ranks editions by discount. Refreshes continuously.",
      "Prices updated continuously from chain events.",
      "Always up-to-date fair value for every edition.",
      "Real-time data across five collections.",
      "Live prices for every Top Shot edition.",
    ]
    for (const s of samples) {
      expect(FRESHNESS_CLAIMS.some((r) => r.test(s)), `no pattern matched: ${s}`).toBe(true)
    }
    // ...and a description that merely says what the board IS must stay clean.
    expect(
      FRESHNESS_CLAIMS.some((r) =>
        r.test("Ranks editions by discount. Every ask carries the time we last confirmed it."),
      ),
    ).toBe(false)
  })

  it("BAN: no layout description asserts that the data is current", () => {
    const bad: string[] = []
    for (const file of LAYOUTS) {
      for (const d of descriptions(readFileSync(file, "utf8"))) {
        for (const re of FRESHNESS_CLAIMS) {
          if (re.test(d)) bad.push(`${path.relative(ROOT, file)} — ${String(re)}\n    "${d}"`)
        }
      }
    }
    expect(
      bad.join("\n"),
      "A freshness claim in static metadata or JSON-LD cannot be withdrawn when the\n" +
        "feed dies — it is emitted before any row is known and is read by machines.\n" +
        "Describe what the board IS; let the rows report how fresh they are:\n" +
        bad.join("\n"),
    ).toBe("")
  })
})
