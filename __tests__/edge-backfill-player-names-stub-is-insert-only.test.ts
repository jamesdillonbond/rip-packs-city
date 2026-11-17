// @vitest-environment node
//
// supabase/functions/backfill-player-names writes a STUB badge_editions row
// (`set+play+0`, circulation_count/low_ask NULL, series 0) for an edition it
// could not find. Until 2026-11-02 a FAILED existence read fell through as
// "absent" and the merge upsert overwrote the real badge row. Pinned by reading
// the body: the read error is checked, and the stub write is insert-only.

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const SRC = stripComments(
  fs.readFileSync(path.resolve(__dirname, "../supabase/functions/backfill-player-names/index.ts"), "utf8"),
)

describe("backfill-player-names never overwrites a real badge row", () => {
  it("destructures and checks the existence read's error before writing", () => {
    expect(SRC).toMatch(/\{\s*data:\s*existing,\s*error:\s*existingError\s*\}/)
    expect(SRC).toMatch(/if\s*\(\s*existingError\s*\)\s*\{[\s\S]{0,60}continue/)
  })

  it("the badge_editions stub write is insert-only", () => {
    const m = SRC.match(/\.from\('badge_editions'\)\s*\.upsert\([\s\S]*?\{\s*onConflict:\s*'id'([^}]*)\}/)
    expect(m, "badge_editions upsert not found").not.toBeNull()
    expect(m![1]).toMatch(/ignoreDuplicates:\s*true/)
  })
})
