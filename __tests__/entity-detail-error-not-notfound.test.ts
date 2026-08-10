import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// deep-audit D10. All five SEO entity detail pages must treat an RPC ERROR as an
// error (throw -> retryable boundary), NOT as "not found".
//
// Collapsing both into `return null` feeds `if (!detail) notFound()`, so a
// statement timeout renders as "this thing does not exist" on a page that really
// exists — observed as /nba-top-shot/series/series-4 appearing to 404 while
// get_series_detail returns a populated row (3,596 editions, $121k FMV).
//
// It also defeats lib/entity-detail-gate.ts, which deliberately FAILS OPEN so
// that "a transient pool blip must never emit a 404 and invite Google to drop a
// real page" — the page was undoing that one call later. ~20,500 sitemap URLs
// sit on these five routes.
//
// set / player / team were fixed 2026-07-14; edition and series were missed.
//
// Anchored on the DETAIL fetch's own log line, not on the first `if (error)` in
// the file — edition has a second error branch (pack provenance) that returns
// null legitimately, and matching that one made this test assert the wrong thing.

const ENTITIES = ["edition", "set", "player", "team", "series"] as const

function pagePath(entity: string): string {
  return join(process.cwd(), "app", "(collections)", "[collection]", entity, "[slug]", "page.tsx")
}

/** Lines of the detail fetch's error branch, located by its console.error. */
function detailErrorBranch(entity: string): string {
  const lines = readFileSync(pagePath(entity), "utf8").split(/\r?\n/)
  const i = lines.findIndex(
    (l) => l.includes("console.error") && l.includes(`[${entity}]`) && /detail/i.test(l),
  )
  if (i < 0) return ""
  // Stop at the branch's closing brace. A fixed-size window overshoots into the
  // `if (!data) return null` that legitimately follows — that is the
  // genuinely-absent case, which SHOULD 404.
  const out: string[] = []
  for (let j = i; j < lines.length; j++) {
    if (/^\s*\}\s*$/.test(lines[j])) break
    out.push(lines[j])
  }
  return out.join("\n")
}

describe("entity detail pages: an RPC error is not a 404", () => {
  it.each(ENTITIES)("%s page exists (guards a vacuous pass)", (entity) => {
    expect(existsSync(pagePath(entity))).toBe(true)
  })

  it.each(ENTITIES)("%s logs its detail RPC error (anchor for the check below)", (entity) => {
    expect(detailErrorBranch(entity), `${entity}: no detail-error log line found`).not.toBe("")
  })

  it.each(ENTITIES)("%s throws on a detail RPC error instead of returning null", (entity) => {
    const branch = detailErrorBranch(entity)
    expect(branch, `${entity}: detail error branch must throw`).toMatch(/throw new Error/)
    expect(branch, `${entity}: detail error branch must not swallow into null`).not.toMatch(
      /return null/,
    )
  })
})
