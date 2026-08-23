import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── An FMV gap is not evidence about the market ─────────────────────────────
//
// app/(collections)/[collection]/edition/[slug]/page.tsx renders a note when
// `!fmvAvailable`, i.e. when we hold no FMV for the edition. Until 2026-08-22
// that note read "No recent market activity" — a claim about THE MARKET
// manufactured from a gap in OUR PRICING, which is the single most productive
// defect class on this platform.
//
// It was reachable rather than theoretical. `fmvAvailable` is
// `fmv && fmv.fmv_usd !== null`, and `sales_count_30d` sits on that same object,
// so the branch fires on editions we KNOW sold — most Golazos editions are
// unpriced (0.9% at HIGH/MED) while still trading. And on Disney Pinnacle a Pin
// also moves by peer-to-peer TRADE, which leaves no sale row at all
// (lib/pinnacle/trade-classifier.ts), so "no activity" is wrong there even when
// the sale count is a true zero.
//
// ⚠ COMMENTS ARE STRIPPED BEFORE MATCHING. The fix's own comment quotes the
// banned sentence to explain why it was wrong, and at least six guards in this
// repo have fired on the comment documenting the fix rather than on live code.
// A guard that reds on its own documentation trains people to delete the
// documentation.

const ROOT = path.resolve(__dirname, "..")
const PAGE = "app/(collections)/[collection]/edition/[slug]/page.tsx"

function source(): string {
  return stripComments(readFileSync(path.join(ROOT, PAGE), "utf8"))
}

describe("edition page — an FMV gap is not a market claim", () => {
  it("is not vacuous: the file exists and still has the !fmvAvailable branch", () => {
    // Without this the guard passes on a renamed variable or a moved file while
    // asserting nothing at all.
    const src = source()
    expect(src).toContain("fmvAvailable")
    expect(src).toMatch(/!fmvAvailable\s*&&/)
  })

  it("never concludes the MARKET was quiet from our own missing price", () => {
    const src = source()
    // The banned shape is a claim about activity/the market in the copy. Pinned
    // as a PROPERTY (any "no ... activity" phrasing), not as the one spelling
    // that shipped, so a reword cannot slip past it.
    expect(src).not.toMatch(/no\s+recent\s+market\s+activity/i)
    expect(src).not.toMatch(/no\s+market\s+activity/i)
  })

  it("does not default the sales count — a null count is UNKNOWN, not zero", () => {
    // ⚠ `?? 0` on a count is the fabricated-number shape: it publishes a
    // measured zero that was never measured. sales_count_30d is independently
    // nullable from the fmv object it sits on.
    const src = source()
    expect(src).not.toMatch(/sales_count_30d\s*\?\?\s*0/)
  })

  it("distinguishes THREE states, so an unknown count cannot render as a market claim", () => {
    // read-unknown → a statement about us; sold-but-unpriced → a statement about
    // us that concedes it traded; a real zero → a claim about SALES only.
    const src = source()
    // The read-succeeded signal is named once and reused, so a later edit cannot
    // silently drop the gate from one arm while leaving the others intact.
    expect(src).toMatch(/const salesCountKnown\s*=\s*fmv\s*!=\s*null\s*&&\s*fmv\.sales_count_30d\s*!=\s*null/)
    const branch = src.slice(src.indexOf("!fmvAvailable &&"))
    expect(branch).toMatch(/!salesCountKnown/)
    expect(branch).toMatch(/sales_count_30d!?\s*>\s*0/)
    // ⚠ The surviving zero-case claim must be scoped to SALES, never to
    // "activity", AND must go through the shared helper — the repo's own
    // entity-section guard requires an explicit ok rather than inline gating,
    // because inline gating is exactly what a later edit loses.
    expect(branch).toMatch(/sectionEmptyCopy\(\s*salesCountKnown/)
    expect(branch).toMatch(/no sales in the last 30 days/i)
  })
})
