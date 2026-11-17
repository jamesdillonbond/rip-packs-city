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

  // ⚠ THIS CASE WAS INVERTED THE SAME DAY IT WAS WRITTEN, AND THAT IS THE LESSON.
  // It began as a no-change control asserting the All Day FMV map still carried
  // `if (page.length < FMV_PAGE) break;` — i.e. it pinned the SPELLING of one
  // paging loop. Hours later that loop was deleted on purpose: the read was
  // paging `fmv_current` filtered by `collection_id`, which cannot push down
  // (the view is DISTINCT ON (edition_id)), costing 263,392 buffers / 19.5 s per
  // page and timing the route out at 45 s. The map is now built the other way
  // round — editions first, then `.in("edition_id", …)`.
  //
  // The PROPERTY the control was really protecting — the All Day FMV map is
  // bounded, never one unbounded read — still holds, and holds better. So the
  // case is inverted rather than deleted, and now pins the property.
  //
  // ⚠ INVERTED A SECOND TIME, 2026-09-02, for a REASON WORTH KEEPING: the first
  // inversion pinned `.from("fmv_current").in("edition_id", chunk)` and justified
  // it with "that qual reaches the index". It does — and it is still expensive,
  // because the view has no per-group LIMIT, so the index-cond scan reads every
  // snapshot row per edition and `Unique` discards all but the newest. Warm, same
  // session, the whole 6,190-edition AD id list: 424,475 buffers / 631 ms for the
  // view against 24,760 / 51 ms for `get_editions_latest_fmv()`'s per-id LATERAL
  // LIMIT 1. **"Reaches the index" is not "is cheap".** The bound is what this
  // case protects, so it follows the read rather than pinning where it lives.
  it("the All Day FMV map is bounded by an edition-id list, not a collection scan", () => {
    const body = fnBody("computeAllDaySniperFeed")
    // The bound: chunked, and keyed on the ids the editions read just produced.
    expect(body).toMatch(/\.rpc\(\s*["']get_editions_latest_fmv["']/)
    expect(body).toMatch(/p_edition_ids:\s*chunk/)
    expect(body).toMatch(/editionIds\.slice\(i,\s*i \+ FMV_RPC_CHUNK\)/)
    // …and the chunk stays under the 1000-row cap, which applies to an RPC result
    // set exactly as it does to a table read. Assert the VALUE, not the constant:
    // raising it to 6,190 would keep every spelling above and silently truncate.
    const chunkSize = Number(/FMV_RPC_CHUNK\s*=\s*(\d+)/.exec(body)?.[1])
    expect(chunkSize).toBeGreaterThan(0)
    expect(chunkSize).toBeLessThanOrEqual(1000)
    // And the shape that caused the timeout must NOT come back. A collection-wide
    // scan needs the view: pinning its ABSENCE here is narrower than grepping for
    // `collection_id`, which this function legitimately uses on `editions`.
    expect(body).not.toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
  })

  it("POSITIVE CONTROL: the fmv_current absence check can fail", () => {
    // Without this, a rename of the function under test would leave an assertion
    // that passes because it matched nothing — the failure mode that has killed
    // three guards in this repo.
    const reverted = `const { data } = await c.from("fmv_current").select("edition_id").eq("collection_id", X)`
    expect(reverted).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
  })

  it("the editions read that feeds it is itself paged", () => {
    // Inverting the order moves the 1000-row cap onto `editions`, so the bound
    // has to move with it or the fix trades one silent truncation for another.
    const body = fnBody("computeAllDaySniperFeed")
    expect(body).toMatch(/\.gt\(\s*["']id["']\s*,\s*edCursor\s*\)/)
    expect(body).toMatch(/rows\.length\s*<\s*ED_PAGE/)
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
