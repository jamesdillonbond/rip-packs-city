import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The series page's rollup FALLBACK must say it is a floor, not a total.
//
// ── THE STATE THIS COVERS ───────────────────────────────────────────────────
// `/{collection}/series/{slug}` builds its "Sets in this Series" / "Top Players"
// cards from `get_series_rollups`, which aggregates over ALL editions. When that
// RPC fails it falls back to grouping the fetched page of AT MOST `PAGE_SIZE`
// (100) editions — the pre-B5 behaviour the file's own header describes.
//
// ⚠ THE FALLBACK IS DELIBERATE AND IS NOT BEING REVERTED. Its comment makes the
// product call explicitly: "partial … but better than hiding the sections", and
// that is defensible. What was missing is that the partial was SUBSTITUTED
// SILENTLY — a card reading "12 editions · $4,300" is indistinguishable from the
// true series aggregate, on a page whose own stat strip may say the series holds
// hundreds. The canon's answer to a partial is to CARRY its partialness, not to
// hide the section and not to publish it as complete.
//
// ── WHY THIS PAGE AND NOT A SWEEP ───────────────────────────────────────────
// The page already had the three-state vocabulary and used two of them:
//   both bases failed        → `cardsUnavailable` → <SectionUnavailable/>
//   rollups ok               → whole-series aggregates
//   rollups failed, page ok  → ← THIS ONE, previously unlabelled
// So this is a missing FLAG, not a missing concept — which is why the fix is
// four lines and why the guard below pins the flag's DERIVATION rather than copy.
//
// ⚠ ASSERTED ON SOURCE, deliberately. Driving the real page needs a Supabase
// client, a collection fixture and two RPCs; the property that actually broke is
// the WIRING (a flag that is computed and then used), which is exactly what a
// source assertion can hold and what a mocked render would not prove.

const PAGE = join(
  process.cwd(),
  "app",
  "(collections)",
  "[collection]",
  "series",
  "[slug]",
  "page.tsx",
)
const src = readFileSync(PAGE, "utf8")

describe("the series rollup fallback declares itself partial", () => {
  it("derives a cardsPartial flag from BOTH conditions, not from one", () => {
    // ⚠ Both halves matter and pinning only one would let the flag drift into
    // being always-true or always-false:
    //   rollups === null  → the whole-series aggregate is missing
    //   editionsOk        → but we DO have a page to group, so cards render
    // `rollups === null` alone would also be true when editions failed, which is
    // the `cardsUnavailable` case and must NOT show a "counted from the first
    // 100" note over zero cards.
    expect(src, "cardsPartial must exist").toMatch(/const cardsPartial\s*=/)
    expect(src, "cardsPartial must be derived from rollups === null AND editionsOk").toMatch(
      /const cardsPartial\s*=\s*rollups === null && editionsOk/,
    )
  })

  it("still distinguishes the BOTH-FAILED state separately", () => {
    // The no-change control: the pre-existing state must survive the new one.
    // If a later edit collapsed these two into one flag, a total read failure
    // would start rendering "counted from the first 100 editions" over nothing.
    expect(src).toMatch(/const cardsUnavailable\s*=\s*rollups === null && !editionsOk/)
    expect(src, "the both-failed branch must still render SectionUnavailable").toMatch(
      /cardsUnavailable && \([\s\S]{0,400}SectionUnavailable/,
    )
  })

  it("states the BOUND, and states which direction the number is wrong in", () => {
    // ⚠ "may be incomplete" is not actionable. The note names PAGE_SIZE and says
    // the number is a FLOOR — a reader can act on both.
    expect(src, "the note must name the bound via PAGE_SIZE, not a hardcoded 100").toMatch(
      /first \{fmtCount\(PAGE_SIZE\)\} editions/,
    )
    expect(src, "the note must say which way it is wrong").toMatch(/floor, not the series total/)
  })

  it("shows the note on BOTH card sections, not just the first", () => {
    // The defect is per-PANEL. Sets and Top Players are built from the same
    // fallback and are equally partial; labelling one and not the other would be
    // the "fix per page, not per panel" shape this repo keeps re-finding.
    const uses = src.match(/\{cardsPartial && partialNote\}/g) ?? []
    expect(uses.length, "expected the note on both Sets and Top Players").toBe(2)

    for (const title of ["Sets in this Series", "Top Players in this Series"]) {
      const at = src.indexOf(`<Section title="${title}">`)
      expect(at, `${title} section not found`).toBeGreaterThan(-1)
      expect(
        src.slice(at, at + 260),
        `${title} must render the partial note before its grid`,
      ).toContain("{cardsPartial && partialNote}")
    }
  })

  it("does not gate the note on the cards being non-empty in a way that hides it", () => {
    // Both sections already render only when their array is non-empty, so the
    // note rides along with the cards it describes. Pin that the note sits INSIDE
    // the same conditional block as the grid rather than above the section.
    const at = src.indexOf(`{setCards.length > 0 && (`)
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 900)
    expect(block).toContain("{cardsPartial && partialNote}")
  })
})
