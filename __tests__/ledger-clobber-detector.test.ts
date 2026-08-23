import { describe, it, expect } from "vitest"
import { lostHeadings, headingBody } from "../scripts/find-clobbered-ledger-headings.mjs"

// The CI "Ledger no-clobber guard" reports entries that existed in HEAD~1 and are
// gone in HEAD — the concurrent-session clobber, where a session writes back a
// copy of the ledger it read earlier and destroys entries (and revert paths)
// committed in between.
//
// 🚨 Until 2026-08-23 it computed that set with a bare `comm`, which fired on the
// ONE repair its sibling arm demands: correcting a future-dated heading changes
// the heading string, so the count holds and the set moves. `0fa5388b` failed the
// future-date arm; `2d082db1`, the correction it demanded, failed the clobber arm.
// The guard punished compliance.
//
// The exemption is deliberately narrow — a heading is not "lost" if its BODY (the
// text after the date) reappears — and these tests exist to keep it narrow. The
// three arms that must keep failing are worth more than the one that must stop.

const entry = (heading: string, body = "some prose\n") => `${heading}\n\n${body}\n`

const LEDGER =
  entry("### 2026-08-22 · SHIPPED — first thing") +
  entry("### 2026-08-21 · MEASURED — second thing") +
  entry("### 2026-08-20 · FILED — third thing")

describe("the ledger clobber detector", () => {
  it("reports nothing when the ledger only gained an entry", () => {
    const after = entry("### 2026-08-23 · SHIPPED — a new entry") + LEDGER
    expect(lostHeadings(LEDGER, after)).toEqual([])
  })

  it("does NOT report a heading whose DATE was corrected in place", () => {
    // The repair the future-date arm demands: same entry, PT date instead of UTC.
    const after = LEDGER.replace(
      "### 2026-08-22 · SHIPPED — first thing",
      "### 2026-08-21 · SHIPPED — first thing",
    )
    expect(lostHeadings(LEDGER, after)).toEqual([])
  })

  it("REPORTS a heading that was deleted outright", () => {
    const after = LEDGER.replace("### 2026-08-21 · MEASURED — second thing\n", "")
    expect(lostHeadings(LEDGER, after)).toEqual(["### 2026-08-21 · MEASURED — second thing"])
  })

  it("REPORTS a remove-one/add-one swap, where the COUNT is identical", () => {
    // The 2026-07-19 incident (356 -> 356) that motivated comparing sets at all.
    const after = LEDGER.replace(
      "### 2026-08-21 · MEASURED — second thing",
      "### 2026-08-21 · MEASURED — an unrelated entry",
    )
    const before = (LEDGER.match(/^### /gm) || []).length
    const afterCount = (after.match(/^### /gm) || []).length
    expect(afterCount).toBe(before)
    expect(lostHeadings(LEDGER, after)).toEqual(["### 2026-08-21 · MEASURED — second thing"])
  })

  it("REPORTS a heading whose WORDING changed, even on the same date", () => {
    // From outside, a reword is indistinguishable from delete-plus-add, so it stays
    // reported. Only the date may move silently.
    const after = LEDGER.replace(
      "### 2026-08-20 · FILED — third thing",
      "### 2026-08-20 · FILED — third thing, rephrased",
    )
    expect(lostHeadings(LEDGER, after)).toEqual(["### 2026-08-20 · FILED — third thing"])
  })

  it("strips only the date prefix when deriving a body", () => {
    expect(headingBody("### 2026-08-22 · SHIPPED — x")).toBe("· SHIPPED — x")
    // ⚠ A heading with NO date keeps its full text, `### ` and all — the prefix is
    // stripped only when a date is actually there. That is the conservative
    // behaviour and it is asserted rather than assumed: a dateless heading can
    // then only be exempted by an identical dateless heading, and a heading that
    // LOSES its date reads as a wording change and stays reported.
    expect(headingBody("### no date here")).toBe("### no date here")
  })

  it("is not vacuous: it finds every heading in a realistic file", () => {
    // Guards the case where the heading regex stops matching and every arm above
    // passes by inspecting nothing.
    expect(lostHeadings(LEDGER, "")).toHaveLength(3)
  })
})
