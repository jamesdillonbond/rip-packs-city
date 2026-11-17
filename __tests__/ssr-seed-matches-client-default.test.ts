// The SERVER-rendered seed of a board must be fetched with the SAME filters the
// CLIENT defaults to — otherwise the two disagree and only a crawler can tell.
//
// ── THE DEFECT, measured on the served HTML 2026-08-23 ─────────────────────
// `app/insights/pack-sniper/page.tsx` opens with: "This puts the ranked table
// AND the per-row drill-down links into the raw server HTML so the unique
// content is crawlable." It fetched with `includeHighVariance: false`; the
// client defaults `showHighVariance = true`. Against production:
//
//   GET /insights/pack-sniper  →  200, 64 KB, `/pack/dist/` links: 0
//   API include_high_variance=false → matched 84, highVariance 84, returned 0
//   API include_high_variance=true  → matched 84, highVariance 84, returned 84
//   (AllDay control: false → 30, true → 95 — the filter, not a broken API)
//
// EVERY matched Top Shot pack is high-variance right now, so hiding them hid the
// entire board. A crawler saw zero deals; a human saw 84.
//
// 🚨 THE CLIENT FIX MASKED THE SERVER BUG. The 2026-07-09 reconciliation
// defaulted the client to `true` for precisely this reason, and because users
// then saw a full board, nobody noticed the HTML was empty for weeks. **A
// divergence that only a crawler can see has no human reporter** — which is why
// this is a static guard and not something to catch in review.
//
// ⚠ IT IS NOT AN HONESTY DEFECT IN THE HONESTY-CANON SENSE: the read SUCCEEDED
// and returned zero rows, so no failure was published as a fact. It is a
// promise the page makes in its own header and does not keep.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const SERVER = join(process.cwd(), "app", "insights", "pack-sniper", "page.tsx")
const CLIENT = join(process.cwd(), "app", "insights", "pack-sniper", "PackSniperClient.tsx")

/** ⚠ Comments stripped: both files EXPLAIN this defect in prose, quoting both spellings. */
function code(p: string): string {
  return stripComments(readFileSync(p, "utf8"))
}

describe("pack-sniper: the server seed and the client default agree", () => {
  it("locates both halves — a walk that finds nothing reads as coverage", () => {
    expect(code(SERVER)).toContain("getPackDeals(")
    expect(code(CLIENT)).toContain("showHighVariance")
  })

  it("the server seeds with the SAME high-variance setting the client defaults to", () => {
    const server = code(SERVER).match(/includeHighVariance:\s*(true|false)/)
    expect(server, "no includeHighVariance on the server fetch").not.toBeNull()

    const client = code(CLIENT).match(/useState\(\s*(true|false)\s*\)[^\n]*\n?/)
    const clientDefault = code(CLIENT).match(
      /const \[showHighVariance,[^\]]*\]\s*=\s*useState\(\s*(true|false)\s*\)/,
    )
    expect(clientDefault, "no showHighVariance useState default on the client").not.toBeNull()
    void client

    expect(
      server![1],
      `server seeds includeHighVariance=${server![1]} but the client defaults showHighVariance=${clientDefault![1]} — the served HTML and what a human sees disagree`,
    ).toBe(clientDefault![1])
  })

  it("the server seed is not the hide-everything setting", () => {
    // ⚠ Belt and braces, and NOT redundant with the equality above: flipping BOTH
    // to `false` would satisfy equality while restoring the empty board, since
    // every matched Top Shot pack is currently high-variance.
    expect(
      code(SERVER),
      "the crawlable seed must not hide high-variance packs — every matched TS pack is one",
    ).toMatch(/includeHighVariance:\s*true/)
  })

  it("the page still claims crawlable rows in its header — the promise this guard keeps", () => {
    // If someone deletes the claim, this guard is arguing for a property the page
    // no longer asserts, and should be revisited rather than silently kept.
    expect(readFileSync(SERVER, "utf8")).toMatch(/raw server HTML/)
  })
})
