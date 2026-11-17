import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// /api/cache-refresh is the INCREMENTAL stub path: it inserts and enriches wallet_moments_cache
// rows. It has never deleted one.
//
// ⛔ WHAT THIS PINS, AND WHY IT IS WORTH A TEST. The route used to compute `removed_count` by
// diffing its `cachedIds` set against `new Set(onChainIds)` and counting the misses as
// "sold/burned". `cachedIds` is built ENTIRELY from rows matching `.in("moment_id", chunk)` where
// every chunk is a slice of `onChainIds` — so `cachedIds` is a SUBSET of `onChainIds` by
// construction and the miss branch was unreachable. It walked every cached id on every refresh to
// produce a constant zero, and shipped that constant in a JSON field named like a measurement.
//
// ⭐ The gap had been NAMED IN PLACE and never closed — the deleted code carried the comment
// "We need all cached IDs for this, not just the ones we queried". A comment stating a
// precondition the code does not meet is not a caveat; it is an unclosed bug with an alibi.
//
// Removal is real, it just lives elsewhere (verified live 2026-09-19): `upsert_wallet_moments`
// (the full-set writer, deletes rows not in the supplied set), `prune_stale_wmc()` (pg_cron jobid
// 199, weekly) and `purge_candy_wmc_ghost_rows()` (jobid 201, daily).
//
// So this file fails if someone "restores" the diff, or teaches this route to delete without
// revisiting the note — either of which would re-create a constant dressed as a finding.

const RAW = readFileSync(join(process.cwd(), "app/api/cache-refresh/route.ts"), "utf8")

// ⭐ Judge CODE, not prose. The first version of this file matched against the raw source and
// immediately failed on its OWN explanatory comments, which quote the removed shapes verbatim
// ("reconciled earlier in this route", `new Set(onChainIds)`) precisely so a future reader knows
// what was deleted and why. A guard anchored on raw text punishes the documentation that makes it
// legible, and the lesson it teaches is "delete the comment" — the opposite of what is wanted.
//
// ⚠ AND MY FIRST STRIPPER WAS THE EXACT BLIND ONE `guards-use-the-shared-comment-stripper` EXISTS
// TO RATCHET OUT: a local two-regex helper running the BLOCK regex before the LINE regex, so a
// line comment mentioning a glob (`// used by /api/*`) opens a block that closes at the next `*/`
// anywhere in the file — blanking real source with no error, which is why that ratchet says a
// blind stripper "still runs, still reports a population, and still passes". CI caught it on the
// population count, not on a wrong answer. Use the shared one; never hand-roll this.
const SRC = stripComments(RAW)

describe("/api/cache-refresh — does not reconcile removals, and must not pretend to", () => {
  it("never deletes from wallet_moments_cache", () => {
    // Deliberately broad: any delete call at all in this route is the thing to re-read the
    // comment block for, not just one spelling.
    const deletes = SRC.split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /\.delete\s*\(/.test(l) && !l.trimStart().startsWith("//"))
    expect(deletes, `unexpected delete() in cache-refresh:\n${deletes.map(([n, l]) => `${n}: ${l.trim()}`).join("\n")}`)
      .toEqual([])
  })

  it("does not re-introduce the unreachable cachedIds-vs-onChainIds diff", () => {
    // The exact shape that produced the constant. Matching on the membership test rather than on
    // a variable name, so a rename does not slip past.
    expect(SRC).not.toMatch(/!\s*onChainSet\.has\(/)
    expect(SRC).not.toMatch(/new Set\(\s*onChainIds\s*\)/)
  })

  it("keeps removed_count a stated constant with the reason next to it", () => {
    expect(SRC).toMatch(/const removedCount = 0/)
    // These two are asserted against RAW on purpose: they are a documentation requirement, not a
    // code one. The note must keep naming who DOES remove, or the next reader re-derives it.
    expect(RAW).toMatch(/upsert_wallet_moments/)
    expect(RAW).toMatch(/prune_stale_wmc/)
  })

  it("does not claim this route reconciles, outside the note recording the correction", () => {
    // RAW still contains the phrase once — inside the ⚠ CORRECTED block that explains it was
    // false. What must not come back is a SECOND, unqualified occurrence.
    const hits = RAW.match(/reconciled earlier in this route/g) ?? []
    expect(hits.length, "the corrected-comment note should appear exactly once").toBe(1)
    expect(RAW).toMatch(/CORRECTED 2026-09-19[\s\S]{0,400}reconciled earlier in this route/)
  })
})
