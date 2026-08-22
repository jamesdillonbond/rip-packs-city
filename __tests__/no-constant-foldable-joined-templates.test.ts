// BAN AT POPULATION ZERO — a `+`-joined template chain whose every interpolation
// is a compile-time constant.
//
// WHY. On 2026-08-22 production rendered a sentence the committed source does
// not contain. `lib/analytics/ts-listings-retired.ts` held three template
// literals joined with `+`; turbopack CONSTANT-FOLDED the chain into one literal
// and dropped a quasi while doing it, so the text after the first template's
// last interpolation — `" and its last row was "` — simply vanished. Users read:
//
//     "...was switched off on 2026-05-26written on 2026-05-15, so no depth..."
//
// ⚠ NO SOURCE-LEVEL TEST COULD HAVE CAUGHT THAT ONE. vitest evaluates the module
// and gets the correct string; `tsc` is clean; the deploy was READY. The defect
// existed only in the built artifact and was found by rendering production.
//
// ⚠ SO THIS GUARD DOES NOT CHECK THE OUTPUT — IT BANS THE PRECONDITION.
// Folding a `+`-joined chain into a single literal requires EVERY interpolation
// in it to be a compile-time constant. A template carrying a runtime value
// cannot be folded, so it cannot lose a quasi this way. Keep the population at
// zero and the bug has nothing to act on.
//
// ⚠ THIS IS A BAN, NOT A CLEANUP, AND THE DIFFERENCE MATTERS. A 2026-08-22 sweep
// measured 42 at-risk-SHAPED concatenations across these roots and found ZERO
// that are constant-foldable — including every user-facing worry the original
// filing named (outbound alert copy, the wallet-page description and JSON-LD).
// A blanket lint rule against `+`-joined templates would therefore have banned
// 42 sites to prevent a defect none of them can exhibit. What is NOT established
// is that turbopack's fold is correct in general: one real fold, one dropped
// quasi. The next constant-only joined template would hit it again.
//
// ⚠ BOUNDARY, stated so a passing run is not over-read: this walks `app`,
// `components`, `lib` and `workers`. `supabase/functions/**` (bundled separately
// by Deno) and `scripts/**` are NOT walked — unmeasured, not clean.
//
// THE FIX when this fires: write ONE template literal. Not `+`-joined pieces,
// and not a rearrangement that keeps the join.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOTS = ["app", "components", "lib", "workers"]

/** A chain of two or more template literals joined by `+`. */
const JOINED_CHAIN = /(`[^`]*`(?:\s*\+\s*`[^`]*`)+)/g
/** True when some template in the chain carries text AFTER its final `${}`. */
const HAS_TAIL_AFTER_INTERP = /\$\{[^`]*\}[^`\n]+`/
const INTERPOLATION = /\$\{([^{}]*)\}/g
/** `const NAME = "..."` / `const NAME: T = '...'` — a foldable string constant. */
const STRING_LITERAL_CONST =
  /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*["'][^"']*["']\s*$/gm

export interface FoldableSite {
  file: string
  line: number
  interpolations: string[]
}

/** Every constant-foldable `+`-joined template chain in one file's source. */
export function foldableSitesIn(src: string, file = "<memory>"): FoldableSite[] {
  const code = stripComments(src)
  const literalConsts = new Set<string>()
  for (const m of code.matchAll(STRING_LITERAL_CONST)) literalConsts.add(m[1])

  const hits: FoldableSite[] = []
  for (const m of code.matchAll(JOINED_CHAIN)) {
    const chain = m[1]
    if (!HAS_TAIL_AFTER_INTERP.test(chain)) continue
    const names = [...chain.matchAll(INTERPOLATION)].map((x) => x[1].trim())
    if (names.length === 0) continue
    // Foldable only if EVERY interpolation resolves to a string-literal const.
    if (!names.every((n) => literalConsts.has(n))) continue
    hits.push({ file, line: code.slice(0, m.index ?? 0).split("\n").length, interpolations: names })
  }
  return hits
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      walk(full, out)
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full)
    }
  }
  return out
}

// The pre-fix source of the ONE site that actually shipped broken, reduced to
// the shape that matters. This is the guard's positive control: without it,
// "zero offenders" is indistinguishable from a detector that matches nothing.
const KNOWN_BROKEN_FIXTURE = [
  'export const TS_LISTINGS_RETIRED_ON = "2026-05-26"',
  'export const TS_LISTINGS_LAST_ROW_ON = "2026-05-15"',
  "export const BODY =",
  "  `The sampler was switched off on ${TS_LISTINGS_RETIRED_ON} and its last row was ` +",
  "  `written on ${TS_LISTINGS_LAST_ROW_ON}, so no depth is shown here.`",
].join("\n")

// Same shape, but one interpolation is a runtime value — the bundler cannot fold
// it, so it must NOT be reported. Without this, a detector that flagged every
// joined template would pass the positive control and still be wrong.
const BENIGN_RUNTIME_FIXTURE = [
  'export const SITE = "Rip Packs City"',
  "export function msg(count: number) {",
  "  return `${count} rows were written to ` +",
  "    `the table at ${SITE}, which is fine.`",
  "}",
].join("\n")

describe("constant-foldable +-joined template literals are banned", () => {
  const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r)))

  it("inspected a non-trivial number of files", () => {
    // A guard that silently inspects nothing exits clean and reads as coverage.
    expect(files.length).toBeGreaterThan(500)
  })

  it("POSITIVE CONTROL — flags the shape that actually shipped broken", () => {
    const hits = foldableSitesIn(KNOWN_BROKEN_FIXTURE, "fixture.ts")
    expect(hits).toHaveLength(1)
    expect(hits[0].interpolations).toEqual([
      "TS_LISTINGS_RETIRED_ON",
      "TS_LISTINGS_LAST_ROW_ON",
    ])
  })

  it("NEGATIVE CONTROL — does not flag a chain with a runtime interpolation", () => {
    expect(foldableSitesIn(BENIGN_RUNTIME_FIXTURE, "fixture.ts")).toHaveLength(0)
  })

  it("the live tree contains none", () => {
    const offenders = files.flatMap((f) =>
      foldableSitesIn(readFileSync(f, "utf8"), relative(process.cwd(), f).split(sep).join("/")),
    )
    expect(
      offenders.length,
      "A `+`-joined template chain whose interpolations are ALL compile-time constants\n" +
        "can be constant-folded by the bundler, which has been observed DROPPING a quasi —\n" +
        "shipping users a sentence the source does not contain. Write ONE template literal.\n" +
        offenders.map((o) => `  ${o.file}:${o.line}  interpolates ${o.interpolations.join(", ")}`).join("\n"),
    ).toBe(0)
  })
})
