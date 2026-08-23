// `analyze()` from scripts/check-unbounded-server-reads.mjs — the ratchet's
// actual decision procedure, which until now had no test of its own.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The guard shipped with a rule that returned `bounded` the moment it saw a
// budget primitive ANYWHERE in a page's reachable module graph. That is right
// for delegation — a page calling `fetchBoardForPage(fetcher)` is bounded even
// though the raw query lives in the fetcher — and wrong for everything else:
// a SIBLING lib's budget cleared the whole page.
//
// ⚠ The failure mode is the one this repo keeps recording: the instrument got
// LESS sensitive as the tree got partially fixed. Bounding one shared lib
// silently cleared every page importing it. Measured when it happened —
// bounding `lib/flowty-username.ts` dropped six pages off the report while only
// four had been fixed.
//
// ⚠ And it was invisible: the count went DOWN, which is what a ratchet is
// supposed to celebrate. Nothing in the report distinguished "two pages bounded"
// from "six pages cleared, four of them wrongly". Hence assertions on the
// PROPERTY (whose budget vouches for which read) rather than on the count.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { analyze } from "../scripts/check-unbounded-server-reads.mjs"

let dir: string
let page: string

/**
 * `analyze` resolves imports as `@/lib/**` relative to the PROCESS CWD, so the
 * fixture lib tree has to live under a `lib/` inside a cwd we control. Rather
 * than chdir (which would race other suites in the same worker), the fixtures
 * are written under a temp root and cwd is switched only for the duration of
 * each assertion.
 */
function inFixtureCwd<T>(fn: () => T): T {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(prev)
  }
}

const QUERY = 'const { data } = await supabase.from("editions").select("id")'
const BUDGET = 'await withBoardBudget(p, "x")'

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unbounded-analyze-"))
  mkdirSync(join(dir, "lib"), { recursive: true })
  mkdirSync(join(dir, "app"), { recursive: true })
  page = join(dir, "app", "page.tsx")

  // A lib that both queries AND bounds its own query — genuinely fine.
  writeFileSync(join(dir, "lib", "bounded-lib.ts"), `${BUDGET}\n${QUERY}\n`)
  // A lib that queries with no budget anywhere — genuinely not fine.
  writeFileSync(join(dir, "lib", "raw-lib.ts"), `${QUERY}\n`)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("analyze — whose budget vouches for which read", () => {
  it("REGRESSION: a sibling lib's budget does not clear the page's own raw read", () => {
    // The exact shape that produced the false clear: the page imports a lib that
    // carries a budget, and separately performs an unbounded read of its own.
    writeFileSync(
      page,
      [
        'import { resolveUsernames } from "@/lib/bounded-lib"',
        "export default async function P() {",
        `  ${QUERY}`,
        "}",
      ].join("\n"),
    )

    const res = inFixtureCwd(() => analyze("app/page.tsx"))
    expect(res.bounded, "the page's own read is not wrapped by anything").toBe(false)
    expect(res.readAt).toBe("app/page.tsx")
  })

  it("delegation still counts as bounded — the page wraps, the lib queries", () => {
    // ⚠ The control that stops the fix above from becoming a stricter guard that
    // flags correct code. Without it, tightening path-sensitivity could silently
    // turn every `fetchBoardForPage(fetcher)` page into a false positive, and the
    // report would look MORE thorough while being wrong the other way.
    writeFileSync(
      page,
      [
        'import { rows } from "@/lib/raw-lib"',
        "export default async function P() {",
        `  ${BUDGET}`,
        "}",
      ].join("\n"),
    )

    const res = inFixtureCwd(() => analyze("app/page.tsx"))
    expect(res.bounded, "a budget on the page vouches for the lib it wraps").toBe(true)
    expect(res.readAt).toBeNull()
  })

  it("a page reaching only an unbounded lib is reported at that lib", () => {
    writeFileSync(
      page,
      ['import { rows } from "@/lib/raw-lib"', "export default async function P() {}"].join("\n"),
    )

    const res = inFixtureCwd(() => analyze("app/page.tsx"))
    expect(res.bounded).toBe(false)
    expect(res.readAt).toBe("lib/raw-lib.ts")
  })

  it("a page reaching only a self-bounding lib is clean", () => {
    writeFileSync(
      page,
      ['import { rows } from "@/lib/bounded-lib"', "export default async function P() {}"].join("\n"),
    )

    expect(inFixtureCwd(() => analyze("app/page.tsx")).bounded).toBe(true)
  })

  it("REGRESSION: a single-line `x.from(\"t\")` query is visible", () => {
    // ⚠ The `Array.from` exclusion used to be spelled `(?<![A-Za-z])(?<!Array)`,
    // and the first half excludes ANY letter before the dot — so every
    // `supabaseAdmin.from("x")` written on one line was INVISIBLE. The guard
    // matched real code only because chains usually break the line before
    // `.from(`. Measured: 12 files under app/ and lib/ carried a query it could
    // not see. This is the shape, stated explicitly so a future regex edit that
    // reintroduces the blind spot reds here rather than quietly lowering a count.
    writeFileSync(
      page,
      [
        "export default async function P() {",
        '  const { data } = await supabaseAdmin.from("editions").select("id")',
        "}",
      ].join("\n"),
    )

    const res = inFixtureCwd(() => analyze("app/page.tsx"))
    expect(res.bounded).toBe(false)
    expect(res.readAt).toBe("app/page.tsx")
  })

  it("CONTROL — `Array.from` is still not a database read", () => {
    // The exclusion the broken lookbehind pair was trying to express. Without
    // this, "fix the blind spot" could be satisfied by deleting the exclusion,
    // which put `app/page.tsx` and `app/(collections)/layout.tsx` on the report
    // once already and inflated the count from 19 to 31.
    writeFileSync(
      page,
      [
        "export default async function P() {",
        '  const xs = Array.from("abc")',
        "}",
      ].join("\n"),
    )

    expect(inFixtureCwd(() => analyze("app/page.tsx")).readAt).toBeNull()
  })

  it("a page with no read at all is clean", () => {
    writeFileSync(page, "export default async function P() { return null }")
    const res = inFixtureCwd(() => analyze("app/page.tsx"))
    expect(res.bounded).toBe(true)
    expect(res.readAt).toBeNull()
  })

  it("CONTROL — importing the guard does not scan the real app tree", () => {
    // The CLI half is gated behind an entry-point check. Without that gate this
    // import would walk `app/**` on load, and every assertion above would be
    // racing a full production scan.
    expect(inFixtureCwd(() => analyze("app/does-not-exist.tsx")).readAt).toBeNull()
  })
})
