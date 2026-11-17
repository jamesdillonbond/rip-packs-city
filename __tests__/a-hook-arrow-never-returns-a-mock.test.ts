import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── 2026-11-01: a hook that RETURNS a mock makes vitest CALL that mock ─────────────────────────────
// vitest treats a FUNCTION returned from beforeEach / beforeAll as a cleanup hook and invokes it
// after the test. `mock.mockReset()` / `mockClear()` / `mockResolvedValue()` … all return the MOCK,
// and a mock is a function — so `beforeEach(() => fetchMock.mockReset())` calls `fetchMock()` with
// no arguments at teardown. Observed in __tests__/ipfs-thumb-mirror.test.ts: a URL-routing
// mockImplementation threw "unexpected fetch undefined" from `callCleanupHooks`, failing 5 tests that
// were correct. It is harmless only while the mock happens to tolerate a no-arg call, which is why it
// had spread to six files unnoticed. Write the body in braces: `beforeEach(() => { m.mockReset() })`.

const HOOK_RETURNS_MOCK =
  /\b(?:beforeEach|beforeAll|afterEach|afterAll)\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?!\{)[A-Za-z_$][\w$.]*\.mock(?:Reset|Clear|Restore|Implementation|ImplementationOnce|ResolvedValue|ResolvedValueOnce|RejectedValue|RejectedValueOnce|ReturnValue|ReturnValueOnce|Name)\(/

function walk(dir: string, out: string[]) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(ent.name)) out.push(p)
  }
}

describe("no test hook returns a mock (vitest would call it as a cleanup hook)", () => {
  // ⚠ The fixtures are ASSEMBLED ("before" + "Each(") so this file's own source lines cannot match
  // the tree walk below — stripComments removes comments, not string literals.
  const B = "before" + "Each("
  const A = "after" + "Each("
  it("the detector catches the shape and passes the braced form", () => {
    expect(HOOK_RETURNS_MOCK.test(`${B}() => fetchMock.mockReset())`)).toBe(true)
    expect(HOOK_RETURNS_MOCK.test(`${B}() => rpcMock.mockReset().mockResolvedValue({ data: true }))`)).toBe(true)
    expect(HOOK_RETURNS_MOCK.test(`  ${A}async () => m.mockClear())`)).toBe(true)
    expect(HOOK_RETURNS_MOCK.test(`${B}() => { fetchMock.mockReset() })`)).toBe(false)
    // vi.* helpers return `vi`, an object — not called, not this defect.
    expect(HOOK_RETURNS_MOCK.test(`${B}() => vi.clearAllMocks())`)).toBe(false)
  })

  it("no test file under __tests__ or e2e has one", () => {
    const files: string[] = []
    for (const root of ["__tests__", "e2e"]) {
      const abs = path.join(process.cwd(), root)
      if (fs.existsSync(abs)) walk(abs, files)
    }
    // Not vacuous: the walk sees the suite (≈200+ files).
    expect(files.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const f of files) {
      stripComments(fs.readFileSync(f, "utf8")).split("\n").forEach((line, i) => {
        if (HOOK_RETURNS_MOCK.test(line)) offenders.push(`${path.relative(process.cwd(), f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
