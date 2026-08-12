import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Source guard for the "an error and an absence share a return value" defect, on
// two SERVER pages outside /insights (which has its own directory-driven guard).
//
// Neither page is measured by either coverage gate — `app/**/page.tsx` is outside
// the primary gate's include, and an async server component cannot be rendered by
// the jsdom component gate — so a source property is the only automated check
// available. Both fixes are one `ok` flag deep and trivially reverted by a future
// edit, which is exactly what this pins.
//
// 1. /[collection]/pack/[id] — `fetchLifecycle` returned a bare `null` for BOTH an
//    RPC failure and a genuinely-unknown pack. The caller then rendered
//    NotFoundCard (or redirected to a dist page), so a statement timeout told a
//    visitor that a pack which exists does not — and the card is served at HTTP
//    200, so a crawler reads it as a soft-404 for a real page. Same class the deep
//    audit found on the edition and series routes.
//
// 2. /analytics/wallets — `loadDirectory` returned `[]` on failure, which the page
//    rendered as "No wallet activity to display.": a positive claim about the loan
//    book manufactured from a database error.

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8")
}

describe("server pages distinguish a failed read from an absent record", () => {
  it("pack/[id] does not collapse an RPC error into 'not found'", () => {
    const src = read("app", "(collections)", "[collection]", "pack", "[id]", "page.tsx")

    // The fetch must carry the failure out rather than returning a bare null.
    expect(src, "fetchLifecycle must report ok:false on RPC error").toContain(
      "return { lifecycle: null, ok: false }"
    )
    // ...and an absent record must be a DIFFERENT return value.
    expect(src, "an absent record must be ok:true with a null lifecycle").toContain(
      "return { lifecycle: null, ok: true }"
    )
    // The page must branch on it BEFORE the not-found / dist-redirect path.
    expect(src, "page must destructure ok from fetchLifecycle").toMatch(
      /const \{\s*lifecycle\s*,\s*ok\s*\}\s*=\s*await fetchLifecycle\(/
    )
    expect(src, "a failed read must render UnavailableCard, not NotFoundCard").toContain(
      "<UnavailableCard"
    )
    // The failure branch must come before the not-found branch, or the fix is inert.
    expect(
      src.indexOf("if (!ok) {"),
      "the !ok branch must precede the not-found/redirect branch"
    ).toBeLessThan(src.indexOf("lifecycle.status === \"unknown\""))
    // The copy must not assert non-existence.
    expect(src, "UnavailableCard must not claim the pack is absent").toContain(
      "does <strong>not</strong> mean the pack doesn&rsquo;t exist"
    )
  })

  it("analytics/wallets does not report a failed read as 'no activity'", () => {
    const src = read("app", "(analytics)", "analytics", "wallets", "page.tsx")

    expect(src, "loadDirectory must report ok:false on failure").toContain(
      "return { rows: [], ok: false }"
    )
    expect(src, "page must destructure ok").toMatch(
      /const \{\s*rows\s*,\s*ok\s*\}\s*=\s*await loadDirectory\(\)/
    )
    // The "no activity" copy must be gated on a SUCCESSFUL read.
    expect(src, "the empty-state copy must be gated on ok").toMatch(
      /\{ok\s*\n?\s*\?\s*"No wallet activity to display\./
    )
  })
})
