import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// COMPLETENESS: no entity-page section may CONCLUDE about the data from a read
// that failed.
//
// ── The class, and why a guard rather than four fixes ──────────────────────
// `lib/entity-section-rpc.ts` degrades a DECORATIVE section to `[]` after
// retries. That policy is deliberate and unchanged. What it also did was erase
// the difference between "we looked and found none" and "we could not look", so
// four sections concluded out of a failed read:
//
//   "No sales yet."                             (edition · get_edition_recent_sales)
//   "No open offers on this edition."           (edition · get_edition_offers)
//   "No notable serials for this edition yet."  (edition · get_edition_special_serials)
//   "No recent sales."                          (team    · get_team_activity)
//
// All four now route the honest/degraded choice through
// `lib/entity/section-empty-copy.ts`. This guard is what stops the FIFTH from
// shipping: the ones that render nothing at all when empty are fine — a section
// that disappears makes no claim — but a section that writes a sentence about the
// data has to know whether the read succeeded.
//
// ⚠ SCOPED BY WHAT THE COPY DOES, NOT BY FILE. The population is a tree walk of
// the entity surfaces; the suppression list is the curated half. A file-level
// rule would be wrong in both directions here — one file can hold both an
// honest disappearing section and a concluding one.

// ⚠ SCOPED TO THE ENTITY SECTIONS, AND THE BOUNDARY IS STATED RATHER THAN SILENT.
//
// The first version of this guard walked all of `app/(collections)/[collection]`
// and flagged three collection-TAB clients. All three were checked and all three
// are fine, for two different reasons:
//
//   MarketClient "No listings match these filters."  — a claim about the FILTER
//       the reader just set, not about what the platform knows.
//   CollectionOverviewClient "No sales in the last 24h" — already correct via the
//       OTHER honest pattern: `statsUnavailable ? <PanelUnavailable/> : empty`,
//       i.e. the failed-read branch is taken UPSTREAM of the empty state (the
//       deep-audit R1/R4 fix recorded in that file's own header).
//   SniperClient "…have no recent sales to price against…" — explanatory prose
//       about why a filter hides rows, not an empty state at all.
//
// So the client-dashboard layer has its own sanctioned shape (`fetchJson` +
// an unavailable branch) and this guard does not model it. Widening the regex
// until those three passed would have meant asserting a property across a layer
// this change never audited. **What this guard is structurally silent about:
// every surface outside the entity sections below.** That is a boundary, not an
// oversight — but it is the first thing to re-derive if this class resurfaces.
const ROOTS = [
  join(process.cwd(), "components", "entity"),
  ...["edition", "set", "player", "team", "series"].map((seg) =>
    join(process.cwd(), "app", "(collections)", "[collection]", seg),
  ),
]

/** Every .tsx under the entity surfaces. */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith(".tsx")) out.push(p)
  }
  return out
}

/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * also blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

const FILES = ROOTS.flatMap((r) => walk(r))

// A sentence that asserts absence of DATA. Deliberately narrow: "No results",
// "No matches" and the like are about a filter the reader just typed, not about
// what the platform knows, and a failed filter read is a different surface.
// ⚠ `g` is required — `matchAll` throws on a non-global regexp, and `i` alone
// would have made every arm below a TypeError rather than a finding.
// 🚨 WIDENED 2026-08-23, AND THE WIDENING FOUND THE FIFTH THIS GUARD EXISTS TO STOP.
//
// The previous pattern was
//   /No (?:sales|open offers|notable serials|recent sales|offers|listings|history)\b/
// — an alternation of the four KNOWN SPELLINGS. The player page says
// **"No recorded sales yet"**, and `No recorded sales` does not match `No sales`
// because of one adjective. **That is a spelling list, not the property**, and
// this repo's standing rule is to pin the property. Measured while it was live:
// `get_player_top_sales` degraded **202 times across 157 distinct users in 24 h**
// — and `lib/entity/section-empty-copy.ts` names that very RPC in its own
// 2026-08-21 header, so the instance was in the measured population and the fix
// landed on the edition page instead. **Fix per PANEL, not per page.**
//
// Now: "No" + up to two intervening words + a DATA noun.
const CONCLUDES = /\bNo\s+(?:[a-z]+\s+){0,2}(?:sales|offers|serials|listings|history|activity|collectors|holders|editions|moments)\b/gi

/**
 * A match that is NOT a claim about the data.
 *
 * ⚠ Both arms are load-bearing and both were earned by a false positive when the
 * pattern above was widened:
 *
 *  1. THE NEGATION. `*Unavailable` copy says "it does **not mean** this player has
 *     no moments" — the correct DENIAL of the very claim this guard bans. The
 *     register already records a word-ban being tried here and being WRONG for
 *     exactly this reason; a static check cannot separate a claim from its denial
 *     by keyword, so the denial is excluded by its own shape.
 *  2. THE OTHER SANCTIONED GATE. `sectionEmptyCopy(ok, …)` is not the only honest
 *     pattern — `TeamChecklist` renders `failed ? <load-failure> : empty` and is
 *     completely correct. Requiring the helper by name would have reddened it and
 *     pushed a caller toward the helper for a case it does not model.
 */
/**
 * The curated half, as this file's header says it should be: the POPULATION is a
 * tree walk, the EXCEPTIONS are named with a reason. Each entry is asserted to
 * still match, so a suppression cannot outlive the code it excuses.
 */
const SUPPRESSED: Array<{ file: string; phrase: RegExp; why: string }> = [
  {
    file: "app/(collections)/[collection]/series/[slug]/page.tsx",
    phrase: /No editions/,
    why:
      "Gated on `isEmpty = detail.edition_count === 0` — an ANSWER from the DETAIL read, not a section read. " +
      "Deliberately `=== 0` and NOT `(x ?? 0) === 0`: since 2026-08-23 `edition_count` is NULL when that series " +
      "has never been rolled up, and the `?? 0` form turned that UNKNOWN into this very sentence. A NULL now " +
      "falls through to the grid, so the claim renders only on a measured zero.",
  },
]

function rel(f: string): string {
  return f.replace(process.cwd() + "/", "")
}

function isSuppressed(file: string, phrase: string): boolean {
  return SUPPRESSED.some((s) => s.file === file && s.phrase.test(phrase))
}

function isExempt(window: string): boolean {
  return (
    /does\s*(?:<!--\s*-->)?\s*not\s+mean/i.test(window) ||
    /\bnot\b[\s\S]{0,40}\bmean\b/i.test(window) ||
    /sectionEmptyCopy\(/.test(window) ||
    /\b(?:failed|loadFailed|degraded)\b\s*\?/.test(window)
  )
}

describe("no entity section concludes about the data from a failed read", () => {
  it("the walk still finds the entity surfaces (not vacuously passing)", () => {
    expect(FILES.length).toBeGreaterThan(20)
    expect(FILES.some((f) => f.includes("SalesTablePaginated"))).toBe(true)
    expect(FILES.some((f) => f.includes("edition"))).toBe(true)
  })

  it("every concluding empty-state is gated on whether the read succeeded", () => {
    const offenders: string[] = []
    for (const f of FILES) {
      const src = stripComments(readFileSync(f, "utf8"))
      CONCLUDES.lastIndex = 0
      if (!CONCLUDES.test(src)) continue
      // The sentence is allowed only when it is an argument to the shared
      // helper, i.e. the caller had to supply an `ok` to reach it.
      CONCLUDES.lastIndex = 0
      for (const m of src.matchAll(CONCLUDES)) {
        const at = m.index ?? 0
        // ⚠ The window reaches BACK far enough to see a `failed ? … :` gate that
        // sits above two sibling branches, and FORWARD past the sentence so a
        // trailing negation ("… no moments. Reloading …") is visible.
        // ⚠ 520 IS MEASURED, NOT GUESSED. `TeamChecklist`'s honest
        // `failed ? <load-failure> : … : rows.length === 0 ? <empty>` chain puts
        // **394 characters** between the gate and the sentence, because these are
        // long single-line style props. A shorter window reddened correct code.
        // It reaches forward 120 so a trailing negation is visible.
        const window = src.slice(Math.max(0, at - 520), at + 120)
        if (!isExempt(window) && !isSuppressed(rel(f), m[0])) {
          offenders.push(`${f.replace(process.cwd() + "/", "")} :: ${m[0]}`)
        }
      }
    }
    expect(
      offenders.join("\n"),
      "these render a sentence asserting the data is empty, without knowing " +
        "whether the read succeeded. A decorative section degrades to [] on " +
        "failure, so this sentence is published out of failed reads. Route it " +
        "through sectionEmptyCopy(ok, noun, empty) — see " +
        "lib/entity/section-empty-copy.ts:\n" + offenders.join("\n"),
    ).toBe("")
  })

  it("the detector actually fires on the pre-fix shape", () => {
    // Guards the guard. Without this, a broken regex reads as a clean estate.
    const before = 'if (rows.length === 0) { return <div>No sales yet.</div> }'
    const after = 'if (rows.length === 0) { return <div>{sectionEmptyCopy(ok, "Recent sales", "No sales yet.")}</div> }'
    const flags = (src: string) => {
      CONCLUDES.lastIndex = 0
      return [...src.matchAll(CONCLUDES)].some((m) => {
        const at = m.index ?? 0
        return !/sectionEmptyCopy\(/.test(src.slice(Math.max(0, at - 200), at + 40))
      })
    }
    expect(flags(before)).toBe(true)
    expect(flags(after)).toBe(false)
  })

  it("does not fire on a section that simply renders nothing when empty", () => {
    // The honest alternative, and the one most entity sections use: no sentence,
    // no claim. It must stay allowed or this guard pushes people to add copy.
    CONCLUDES.lastIndex = 0
    expect(CONCLUDES.test("{parallels.length > 0 && (<Section …/>)}")).toBe(false)
  })

  it("every suppression still matches something — a stale one must be deleted", () => {
    // ⚠ A suppression that no longer matches is invisible debt: it reads as a
    // considered exception while excusing nothing, and it silently widens the
    // ban's blast radius the day someone re-adds the phrase in that file.
    for (const s of SUPPRESSED) {
      const full = join(process.cwd(), s.file)
      const src = stripComments(readFileSync(full, "utf8"))
      CONCLUDES.lastIndex = 0
      const matches = [...src.matchAll(CONCLUDES)].map((m) => m[0])
      expect(
        matches.some((m) => s.phrase.test(m)),
        `suppression for ${s.file} (${s.phrase}) matches nothing any more — delete it. Reason on file: ${s.why}`,
      ).toBe(true)
    }
  })
})
