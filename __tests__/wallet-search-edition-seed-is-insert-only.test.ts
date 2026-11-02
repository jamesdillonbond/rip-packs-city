// @vitest-environment node
//
// __tests__/wallet-search-edition-seed-is-insert-only.test.ts
//
// seedEditionsToSupabase (app/api/wallet-search/route.ts) runs fire-and-forget on
// EVERY Top Shot wallet search. Until 2026-09-25 it upserted each wallet row with
// ignoreDuplicates:false, so one wallet row re-wrote player_id / name / tier /
// series / circulation_count on an EXISTING edition — NULLs included — over the
// catalog, the on-chain series fill and the linker. The same shape wiped the 48
// chain-filled pack names three hours after they were written (#137 d).
//
// Pinned by reading the function body: the seed may only INSERT.

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const SRC = stripComments(fs.readFileSync(path.resolve(__dirname, "../app/api/wallet-search/route.ts"), "utf8"))

function body(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const next = SRC.indexOf("\nasync function ", start + 1)
  return SRC.slice(start, next === -1 ? undefined : next)
}

describe("wallet-search edition seed never overwrites an existing edition", () => {
  const b = body("seedEditionsToSupabase")

  it("writes editions (the subject exists)", () => {
    expect(b).toMatch(/\.from\("editions"\)\s*\.upsert\(/)
  })

  it("every editions upsert in the seed is ignoreDuplicates:true", () => {
    const calls = b.match(/ignoreDuplicates:\s*(true|false)/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => /true$/.test(c))).toBe(true)
  })
})

// 2026-11-02: the SAME shape on the wallet_moments_cache write. A row whose
// enrichment failed (no edition key) carries NULL fmv / name / tier / set /
// image because they could not be READ; upserted with merge semantics it nulled
// a cached moment's good values. Degraded rows are insert-only; resolved rows
// keep merge semantics (they carry what was read).
describe("wallet-search wmc cache write never clobbers a cached moment with a degraded row", () => {
  const SRC_ALL = SRC

  it("the degraded (unresolved) set is written with ignoreDuplicates:true", () => {
    expect(SRC_ALL).toMatch(/\{\s*rows:\s*unresolvedRows,\s*insertOnly:\s*true\s*\}/)
    expect(SRC_ALL).toMatch(
      /if \(insertOnly\)[\s\S]{0,200}\.from\("wallet_moments_cache"\)\s*\.upsert\(chunk,\s*\{[^}]*ignoreDuplicates:\s*true/,
    )
  })

  it("the resolved set is the only merge write (the subject still exists)", () => {
    expect(SRC_ALL).toMatch(/\{\s*rows:\s*resolvedRows,\s*insertOnly:\s*false\s*\}/)
  })
})
