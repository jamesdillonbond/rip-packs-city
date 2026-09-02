import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"

// REGRESSION PIN — two reads in /api/sniper-feed silently outgrew PostgREST's
// 1000-row cap.
//
// Measured live 2026-09-02:
//   badge_editions, Top Shot scope .......... 9,471 rows (comment claimed 4,981)
//   players, nba_top_shot with a jersey ..... 1,317 rows
//
// Both were read with a bare `.select()`. PostgREST returns 1,000 and no error,
// so `hasBadge` was false for ~89% of the editions that carry a badge and ~24%
// of players never had their jersey serials flagged. There is nothing to notice
// at runtime: the read SUCCEEDS and the map is simply wrong.
//
// ⚠ The existing cap guard (invariants-postgrest-cap.test.ts) could not see
// this. It is scoped to ONE idiom — a raw `fmv_snapshots` read ordered
// `computed_at DESC` — so it is structurally silent about every other unbounded
// read, including two in a file it already names. A guard's DERIVATION fixes
// its blast radius.
//
// ⚠ These pin the PROPERTY (this read pages over a deterministic order), not a
// spelling: a rewrite that keeps paging keeps passing.

const SRC = readFileSync(path.join(process.cwd(), "app", "api", "sniper-feed", "route.ts"), "utf8")

/** The body of a named async function, from its signature to the next top-level `}`. */
function fnBody(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`)
  expect(start, `${name} not found in sniper-feed/route.ts`).toBeGreaterThan(-1)
  const end = SRC.indexOf("\n}\n", start)
  expect(end, `${name} has no closing brace`).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe("sniper-feed: reads over the 1000-row cap stay paged", () => {
  it("the badge map pages badge_editions by KEYSET", () => {
    const body = fnBody("fetchBadgesByEditionKey")
    // ⚠ Assert the paging EXPRESSION, not the word: a `/\.range\(/` check
    // SURVIVED a mutation that deleted the call, because the comment beside it
    // said ".range()" too. Rather than reach for a comment stripper — blind
    // three times on this repo — pin something prose does not carry.
    expect(body).toMatch(/\.gt\(\s*["']external_id["']\s*,\s*cursor\s*\)/)
    expect(body).toMatch(/\.limit\(\s*PAGE\s*\)/)
    // Deterministic order or the page boundary is meaningless: the duplicates
    // and omissions cancel, so every count-based check still passes.
    expect(body).toMatch(/\.order\(\s*["']external_id["']/)
  })

  it("the badge map advances the cursor, or it re-reads page 0 forever", () => {
    const body = fnBody("fetchBadgesByEditionKey")
    expect(body).toMatch(/cursor\s*=\s*next/)
    expect(body).toMatch(/next === cursor/)
  })

  it("the badge map keeps paging until a SHORT page, not for a fixed number of pages", () => {
    const body = fnBody("fetchBadgesByEditionKey")
    expect(body).toMatch(/rowsPage\.length\s*<\s*PAGE/)
  })

  it("the badge read no longer claims the table is small", () => {
    // The old justification — "Safe because badge_editions is a small table
    // (hundreds of rows)" — was true when written and false when it shipped.
    // A row count in a comment is a DATED SAMPLE, never a bound.
    const body = fnBody("fetchBadgesByEditionKey")
    expect(body).not.toMatch(/small table/i)
  })

  it("the jersey-number map pages players", () => {
    const body = fnBody("fetchJerseyNumbers")
    expect(body).toMatch(/\.range\(\s*from\s*,/)
    expect(body).toMatch(/\.order\(\s*["']id["']/)
    expect(body).toMatch(/length\s*<\s*PAGE/)
  })

  it("NO-CHANGE CONTROL: the already-paged All Day FMV map is untouched", () => {
    // It was correct before this change and must stay correct — a fix that
    // rewrote it would be a regression this file should notice.
    expect(SRC).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
    expect(SRC).toMatch(/if \(page\.length < FMV_PAGE\) break;/)
  })

  it("POSITIVE CONTROL: the assertions can fail — a bare .select() has no page window", () => {
    // Proves the checks above are not vacuous against a body that lacks paging.
    const bare = `async function x() { const { data } = await c.from("t").select("a").eq("b", 1); }`
    expect(bare).not.toMatch(/\.range\(\s*from\s*,/)
    expect(bare).not.toMatch(/\.gt\(\s*["']external_id["']\s*,\s*cursor\s*\)/)
  })

  it("POSITIVE CONTROL: the patterns do not match the same words written in a COMMENT", () => {
    // The exact mutant that survived the first sweep: the source comment beside
    // the call said ".range()", so a bare /\.range\(/ matched with the call gone.
    const commentOnly = `  // a .range() without a deterministic order reads the wrong rows;
    // keyset .gt(external_id, cursor) is O(n) instead`
    expect(commentOnly).not.toMatch(/\.range\(\s*from\s*,/)
    expect(commentOnly).not.toMatch(/\.limit\(\s*PAGE\s*\)/)
  })
})
