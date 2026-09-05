// __tests__/a-declared-budget-larger-than-its-own-wall-is-unreachable.test.ts
//
// An API route that declares an internal timeout or soft deadline LARGER than
// its own `maxDuration` has written down a budget it can never reach: the
// lambda is killed first, so the bound the author asked for is inert and the
// tick dies hard instead of breaking out.
//
// ── THE CASE THIS WAS WRITTEN FROM (2026-09-05) ────────────────────────────
// `app/api/cron/resolve-topshot-stubs/route.ts` bounded its edge-function fetch
// with `AbortSignal.timeout(120_000)` while declaring `maxDuration = 30`. The
// declared budget was **4× the wall**, so it could never fire.
//
// ⭐ It was not theoretical. Over 121 invocations from 2026-09-03 03:39Z, **3
// were killed (2.5%)**, and each pairs 1:1 with an edge-function run that
// crossed 30 s — **30,452 / 31,690 / 34,423 ms**. Matched occurrences, not
// merely matching counts.
//
// ⛔ THE WORK SUCCEEDED IN ALL THREE. The edge function logs its own
// `topshot-stub-resolver` row, so a kill produced a Vercel runtime error plus a
// MISSING terminal row for work that had actually completed — the run count
// under-reported while nothing was actually broken.
//
// ⚠ Why this was invisible until 2026-09-03: the route's recorded maximum is
// CENSORED AT ITS OWN WALL by construction — a tick that crossed 30 s wrote no
// row, so it is absent from the distribution rather than at the top of it. The
// uncensored duration lives under the edge function's own pipeline name, and
// kills are readable only by CORRELATION (heartbeat present, terminal row
// absent). The heartbeat that makes that possible was added 2026-09-03.
//
// ── WHY A RATCHET AND NOT A BAN AT ZERO ────────────────────────────────────
// The tree-wide walk finds exactly two routes of this shape. The second,
// `candy-listings-indexer` (`SWEEP_BUDGET_MS` 600 s under a 300 s wall), is
// LATENT: 25 runs, avg 20.6 s, max 38.8 s — it approaches neither bound, so
// there is no measured harm and no evidence to size a change from. It is pinned
// below rather than "fixed" blind.
//
// ⚠ The pin is written so it stays satisfiable at a population of ZERO: fixing
// candy must not red this test. A guard that punishes its own success gets
// deleted, and then the ban goes with it.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const API_ROOT = join(process.cwd(), "app", "api")

/** Known-latent, deliberately unfixed. Removing it from the tree must NOT fail. */
const PINNED_LATENT = "app/api/candy-listings-indexer/route.ts"

const nonWhitespace = (s: string): number => s.replace(/\s/g, "").length

function walkRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkRoutes(p, out)
    else if (entry === "route.ts") out.push(p)
  }
  return out
}

const toRel = (abs: string): string =>
  abs.slice(process.cwd().length + 1).split("\\").join("/")

interface Violation {
  rel: string
  wallMs: number
  declaredMs: number
  kind: string
}

/**
 * Routes whose declared internal budget exceeds their own lambda wall.
 *
 * ⚠ Source MUST be comment-stripped first: this repo's route headers quote
 * `maxDuration` and timeout values in prose constantly, and the very route this
 * guard was written from now documents both numbers in its header. Matching raw
 * text would fire on the explanation.
 */
export function findUnreachableBudgets(files: string[]): {
  violations: Violation[]
  inspected: number
  stripFailures: number
} {
  const violations: Violation[] = []
  let inspected = 0
  let stripFailures = 0

  for (const abs of files) {
    const raw = readFileSync(abs, "utf8")
    const code = stripComments(raw)

    // ⚠ Prove the strip LANDED, and do it by NON-WHITESPACE, not by length.
    // The shared stripper BLANKS comments in place to preserve byte offsets, so
    // `code.length === raw.length` always — a length check reports a strip
    // failure on every commented file. It did exactly that while this guard was
    // being written, silently skipping 444 of 455 routes.
    if (/^\s*\/\//m.test(raw) && nonWhitespace(code) >= nonWhitespace(raw)) {
      stripFailures++
      continue
    }

    const wall = code.match(/export\s+const\s+maxDuration\s*=\s*([0-9_]+)/)
    if (!wall) continue
    inspected++
    const wallMs = Number(wall[1].replace(/_/g, "")) * 1000

    const budgets: Array<{ ms: number; kind: string }> = []
    for (const m of code.matchAll(/AbortSignal\.timeout\(\s*([0-9_]+)\s*\)/g)) {
      budgets.push({ ms: Number(m[1].replace(/_/g, "")), kind: "AbortSignal.timeout" })
    }
    for (const m of code.matchAll(/\b([A-Z_]*(?:DEADLINE|BUDGET)[A-Z_]*_MS)\s*=\s*([0-9_]+)/g)) {
      budgets.push({ ms: Number(m[2].replace(/_/g, "")), kind: m[1] })
    }
    if (budgets.length === 0) continue

    const worst = budgets.reduce((a, b) => (b.ms > a.ms ? b : a))
    if (worst.ms > wallMs) {
      violations.push({ rel: toRel(abs), wallMs, declaredMs: worst.ms, kind: worst.kind })
    }
  }

  return { violations, inspected, stripFailures }
}

describe("a declared budget larger than its own wall is unreachable", () => {
  const files = walkRoutes(API_ROOT)
  const { violations, inspected, stripFailures } = findUnreachableBudgets(files)

  it("inspected a real population — the ban below is not vacuous", () => {
    // Without this, a walker that found nothing would make every assertion pass.
    expect(files.length).toBeGreaterThan(300)
    expect(inspected).toBeGreaterThan(100)
  })

  it("the comment strip landed on every file it was asked to strip", () => {
    // A silent strip failure would hide offenders rather than report them, which
    // is the direction that reads as coverage.
    expect(stripFailures).toBe(0)
  })

  it("BAN AT ZERO — no route declares a budget its own wall cannot reach", () => {
    const unpinned = violations.filter((v) => v.rel !== PINNED_LATENT)
    expect(
      unpinned.map((v) => `${v.rel}: ${v.kind}=${v.declaredMs}ms under a ${v.wallMs}ms wall`),
      "A budget above the lambda wall can never fire — the tick is hard-killed\n" +
        "instead of breaking out, and on an after() route try/catch cannot see it.\n" +
        "Either raise maxDuration above the budget, or lower the budget below the\n" +
        "wall. `resolve-topshot-stubs` lost 3 of 121 invocations to exactly this.\n" +
        "Offenders: ",
    ).toEqual([])
  })

  it("the route the guard was written from now satisfies it", () => {
    const src = readFileSync(
      join(API_ROOT, "cron", "resolve-topshot-stubs", "route.ts"),
      "utf8",
    )
    const code = stripComments(src)
    const wall = code.match(/export\s+const\s+maxDuration\s*=\s*([0-9_]+)/)
    expect(wall, "resolve-topshot-stubs must declare an explicit wall").not.toBeNull()
    const wallMs = Number(wall![1].replace(/_/g, "")) * 1000
    // Its own fetch declares 120 s; the wall must be able to reach that, and the
    // uncensored max observed was 34,423 ms.
    expect(wallMs).toBeGreaterThanOrEqual(120_000)
  })

  it("POSITIVE CONTROL — the detector sees a budget above a wall", () => {
    const bad = "export const maxDuration = 30\nawait fetch(u, { signal: AbortSignal.timeout(120_000) })"
    const code = stripComments(bad)
    const wallMs = Number(code.match(/maxDuration\s*=\s*([0-9_]+)/)![1]) * 1000
    const declared = Number(
      code.match(/AbortSignal\.timeout\(\s*([0-9_]+)\s*\)/)![1].replace(/_/g, ""),
    )
    expect(declared).toBeGreaterThan(wallMs)
  })

  it("NEGATIVE CONTROL — the two numbers quoted in a COMMENT do not count", () => {
    // The shipped route now explains this defect in its header and names both
    // `maxDuration = 30` and `120_000`. A guard that fired on its own
    // explanation would teach the next author to delete the explanation.
    const documented = [
      "// was `export const maxDuration = 30` under AbortSignal.timeout(120_000)",
      "export const maxDuration = 120",
    ].join("\n")
    const code = stripComments(documented)
    expect(code).not.toContain("AbortSignal")
    expect(Number(code.match(/maxDuration\s*=\s*([0-9_]+)/)![1])).toBe(120)
  })
})
