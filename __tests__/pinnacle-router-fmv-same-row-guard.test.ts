import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Replaces the retired smoke check "Pinnacle FMV not borrowed across characters
// (drift guard)" (removed 2026-08-14 from app/api/smoke-test/route.ts).
//
// THE HISTORY MATTERS, because it is the reason this file is a SOURCE guard and
// not a runtime probe. The original defect (`92aab30`) was the concierge joining
// Pinnacle FMV by `edition_key` alone — a set-level key that spans characters and
// renders — so one pin's FMV could be rendered against another's. The runtime
// guard built to catch that later became incapable of catching anything: once
// `a9f86af` moved the FMV source onto `pinnacle_catalog`, the deal rows and the
// comparison rows were the same rows of the same table, so the assertion was
// guaranteed true. It still hard-paged 54 times (Sentry JAVASCRIPT-NEXTJS-14),
// every occurrence verified false.
//
// What actually makes the leak impossible now is a STRUCTURAL property of
// `searchPinnacleDeals`: it selects `floor_ask` and `fmv_usd` from the SAME
// `pinnacle_catalog` row, so the ask, the FMV and the discount all belong to one
// render and there is no join across which anything could leak. A runtime probe
// cannot observe that property — it can only observe its consequence, which is
// exactly why it degenerated into a tautology. A source guard can.
//
// ⚠ So this file is deliberately NOT a re-implementation of the old check. It
// pins the invariant that makes the old check unnecessary. If someone
// reintroduces a second FMV source into this router, this reds — and that is the
// moment a real drift guard would need to be rebuilt.

const SRC = readFileSync(join(process.cwd(), "lib/concierge/pinnacle-router.ts"), "utf8")

/**
 * Strip comments before matching. This repo has repeatedly tripped its own
 * source guards on the comment that documents the rule (`pack-dist-contents-not-
 * streamed`, `collection-analytics-failed-vs-empty-guard`, the OG empty-copy
 * sweep) — and the header above names every table this guard forbids.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * also blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

const CODE = stripComments(SRC)

describe("pinnacle-router — FMV and ask must come from the same catalog row", () => {
  it("is not vacuous: the router source is present and non-trivial", () => {
    expect(SRC.length).toBeGreaterThan(2000)
    expect(CODE).toContain("searchPinnacleDeals")
    // The comment-stripper must not have eaten the file.
    expect(CODE).toContain("pinnacle_catalog")
  })

  it("selects floor_ask and fmv_usd together in one column list", () => {
    // Both live in CATALOG_DEAL_COLUMNS. Splitting them across two selects is
    // the first step back toward a join, so they are pinned as one string.
    const cols = /CATALOG_DEAL_COLUMNS\s*=\s*\n?\s*"([^"]+)"/.exec(CODE)
    expect(cols).not.toBeNull()
    const list = cols![1]
    expect(list).toContain("floor_ask")
    expect(list).toContain("fmv_usd")
    expect(list).toContain("render_id")
  })

  it("reads FMV from no table other than pinnacle_catalog", () => {
    // ⚠ pinnacle_fmv_history is explicitly forbidden here. It looks like the
    // obvious cross-source to reconcile against, and it is NOT one: it is
    // written by an AFTER INSERT/UPDATE trigger on pinnacle_catalog, so it is a
    // derivative copy, and its ON CONFLICT (render_id, computed_at) DO NOTHING
    // silently drops the ASK_ONLY revision whenever a render is rewritten twice
    // inside one recalc transaction (measured 2026-08-14: 776 renders whose
    // latest history row holds a value the catalog never published).
    const FORBIDDEN = [
      "pinnacle_fmv_history",
      "pinnacle_fmv_snapshots", // dropped 2026-06-08; a reference would 42P01
      "fmv_snapshots",
      "pinnacle_editions", // the pre-a9f86af FMV source
      "pinnacle_cached_listings", // frozen Flowty snapshot, uniform $1 floors
    ]
    for (const t of FORBIDDEN) {
      expect(CODE.includes(t), `${t} must not be read by the Pinnacle deal router`).toBe(false)
    }
  })

  it("keeps every .from() in this module on pinnacle_catalog", () => {
    const tables = Array.from(CODE.matchAll(/\.from\(\s*["']([^"']+)["']\s*\)/g)).map((m) => m[1])
    expect(tables.length).toBeGreaterThan(0)
    expect(Array.from(new Set(tables))).toEqual(["pinnacle_catalog"])
  })

  it("derives the discount from the same row's ask and FMV, not a looked-up FMV", () => {
    // The discount is the number a collector acts on. It must be computed from
    // the two values already destructured off `r`, so it cannot pair one
    // render's ask with another's FMV.
    expect(CODE).toMatch(/const\s+ask\s*=\s*Number\(\s*r\.floor_ask\s*\)/)
    expect(CODE).toMatch(/r\.fmv_usd\s*!=\s*null\s*\?\s*Number\(\s*r\.fmv_usd\s*\)\s*:\s*null/)
  })
})

describe("smoke-test — the tautological Pinnacle drift guard stays retired", () => {
  const SMOKE = readFileSync(join(process.cwd(), "app/api/smoke-test/route.ts"), "utf8")

  it("no longer registers a check named for the cross-character FMV drift guard", () => {
    // ⚠ Matches the `name:` FIELD, not the string anywhere in the file — the
    // retirement comment quotes the old name verbatim, and a substring match
    // would red on the explanation of its own removal.
    const names = Array.from(SMOKE.matchAll(/name:\s*"([^"]+)"/g)).map((m) => m[1])
    expect(names).not.toContain("Pinnacle FMV not borrowed across characters (drift guard)")
    // The sibling probe that CAN fail is deliberately still registered.
    expect(names).toContain("Pinnacle searchPinnacleDeals filters character_name correctly")
  })
})
