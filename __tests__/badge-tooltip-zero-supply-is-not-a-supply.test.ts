import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// deep-audit R34. `CollectionMomentTable`'s badge tooltip rendered
// `Circ: {n}` and `Effective supply: {n}` on a `!= null` test, so a row whose
// supply was never populated published **"Circ: 0"** — a fabricated supply,
// in the same type as an accurate one.
//
// Measured live 2026-08-23: **all 218 LaLiga Golazos `badge_editions` rows carry
// `circulation_count = 0` AND `effective_supply = 0`, with ZERO nulls**, and all
// 218 are keyable by `(player_name, series_number)` — so the map can be
// populated and both lines rendered on every Golazos row. R34 named only the
// circulation line; the neighbour on the very next line had the identical shape.
//
// ⚠ THE CORRECT GUARD ALREADY EXISTED IN THIS FILE. The row-level "N minted"
// line tests `!= null && > 0`. One branch was guarded and the one 350 lines
// below it was not — which is exactly why the honesty canon says fix per PANEL,
// not per page.
//
// ⚠ This pins a PROPERTY, not a spelling: every place the component turns a
// badge supply figure into user-visible text must require a POSITIVE number.
// A zero renders nothing, which is the honest output — we have no supply.

const FILE = join(process.cwd(), "components", "collection", "CollectionMomentTable.tsx")
const src = readFileSync(FILE, "utf8")

/**
 * Sites that render a badge supply figure into visible text WITHOUT requiring it
 * to be positive.
 *
 * ⚠ THE GUARD IS NOT ALWAYS ON THE SAME LINE, and a line-scoped detector is
 * wrong here — my first version flagged the already-correct `{…} minted` span,
 * whose `> 0` test sits in the enclosing JSX condition two lines above. So the
 * window is the render line plus the few lines before it, which is where a JSX
 * `cond && (` guard lives. Both forms are pinned as controls below, so the
 * window cannot be widened until green without breaking one of them.
 */
const FIELD = /badgeInfo\.(circulation_count|effective_supply)/
const GUARD_WINDOW = 4

/**
 * ⚠ COMMENTS MUST BE BLANKED, AND THIS COST ME A VACUOUS GUARD BEFORE I CAUGHT
 * IT. The first version searched the raw window for `> 0`. The explanatory
 * comment I had just written above the fixed line contains the characters
 * "`> 0`, NOT `!= null`" — so the COMMENT satisfied the guard, the mutation
 * stopped reddening, and the test passed while proving nothing. This repo
 * records the mirror of that ("at least six guards have fired on the comment
 * documenting the fix"); this is the same defect pointed the other way, and it
 * is the more dangerous direction because it fails OPEN.
 */
function blankComments(s: string): string {
  return s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, (m) => m.replace(/[^\n]/g, " ")) // JSX {/* … */}
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) // /* … */
    .replace(/^\s*\/\/.*$/gm, (m) => " ".repeat(m.length)) // // …
}

function unguardedSupplyRenders(s: string): string[] {
  const raw = s.split(/\r?\n/)
  const code = blankComments(s).split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < code.length; i++) {
    if (!FIELD.test(code[i])) continue
    if (!/<div>|<span>/.test(code[i])) continue // not a visible render
    const window = code.slice(Math.max(0, i - GUARD_WINDOW), i + 1).join("\n")
    if (!/>\s*0/.test(window)) out.push(raw[i].trim())
  }
  return out
}

describe("a zero badge supply is not a supply", () => {
  it("found the render sites at all (not vacuous)", () => {
    // Positive control: a rename or a refactor that moved these out of the file
    // would otherwise make every assertion below pass by finding nothing.
    const anyRender = src.split(/\r?\n/).filter((l) => FIELD.test(l) && /<div>|<span>/.test(l))
    expect(anyRender.length).toBeGreaterThanOrEqual(3)
  })

  it("every visible supply figure requires a POSITIVE number, never merely non-null", () => {
    expect(
      unguardedSupplyRenders(src),
      "these render a supply on a `!= null` test, so a 0 publishes as a fact",
    ).toEqual([])
  })

  it("the detector fires on the exact pre-fix expression (positive control)", () => {
    // Without this the assertion above could be satisfied by a detector that
    // matches nothing — the failure mode this repo keeps paying for.
    const preFix = "        {row.badgeInfo.circulation_count != null && <div>Circ: {row.badgeInfo.circulation_count.toLocaleString()}</div>}"
    expect(unguardedSupplyRenders(preFix)).toHaveLength(1)
  })

  it("the detector does NOT fire when the guard is in the enclosing JSX condition", () => {
    // ⚠ The other half of the control, and the one that stops the window being
    // widened until green: the `{…} minted` span is CORRECT — its `> 0` test is
    // in the condition two lines above. A detector that flags it is wrong, and
    // my first line-scoped version did exactly that.
    const guardedElsewhere = [
      "  {row.badgeInfo && row.badgeInfo.circulation_count != null && row.badgeInfo.circulation_count > 0 && (",
      "    <div className=\"x\" title={\"Minted: \" + row.badgeInfo.circulation_count}>",
      "      <span>{row.badgeInfo.circulation_count.toLocaleString()} minted</span>",
    ].join("\n")
    expect(unguardedSupplyRenders(guardedElsewhere)).toEqual([])
  })

  it("a `> 0` sitting only in a COMMENT does not satisfy the guard", () => {
    // ⚠ The control that stops this whole file failing OPEN. Without comment
    // blanking, the explanatory note above the fixed line — which quotes
    // "> 0" in prose — satisfied the window and the mutation stopped
    // reddening. The guard passed while proving nothing.
    const commentOnly = [
      "  // circulation_count must be > 0 before it is rendered",
      "  {row.badgeInfo.circulation_count != null && <div>Circ: {row.badgeInfo.circulation_count.toLocaleString()}</div>}",
    ].join("\n")
    expect(unguardedSupplyRenders(commentOnly)).toHaveLength(1)

    const jsxCommentOnly = [
      "  {/* guard on > 0 before rendering */}",
      "  {row.badgeInfo.effective_supply != null && <div>Effective supply: {row.badgeInfo.effective_supply.toLocaleString()}</div>}",
    ].join("\n")
    expect(unguardedSupplyRenders(jsxCommentOnly)).toHaveLength(1)
  })

  it("the 1/1 Ultimate branch still reads circulation_count === 1", () => {
    // No-change control. `> 0` must not swallow the branch that exists to call
    // a genuine one-of-one what it is; a 1 is a real supply and must still
    // reach both that test and the Circ line's else-arm.
    expect(src).toMatch(/circulation_count === 1/)
  })
})
