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
