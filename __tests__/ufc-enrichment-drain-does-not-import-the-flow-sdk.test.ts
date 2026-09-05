// __tests__/ufc-enrichment-drain-does-not-import-the-flow-sdk.test.ts
//
// `/api/cron/ufc-enrichment-drain` must not pull the Flow SDK in for the sake of
// one string constant — and the constant it uses must be the same one it used
// before.
//
// ── WHY: 70% OF THE RUNTIME-ERROR SURFACE WAS ONE DEPRECATION WARNING ──────
// The route imported `UFC_COLLECTION_UUID` from
// `lib/chains/flow/wallet-backfill-helpers.ts` — a 2,000-line module whose own
// imports include `@onflow/fcl` and `@onflow/types`. Something in that chain
// calls the deprecated `url.parse()`. Node emits DEP0169 **once per process**, so
// every cold start of this `maxDuration = 300` cron logged one and Vercel
// captured it as a runtime error.
//
// ⭐ MEASURED, and the attribution is what makes it actionable. Over 7 days that
// single group is **299 events**, and its `routes` field lists EXACTLY the two
// routes importing that helper — this one and `/api/wallet-backfill-ufc` — and
// NOT `/api/sniper-feed`, which has far more cold starts (254 timeouts in the
// same window). A global dependency would have shown up everywhere; this did not.
//
// ⚠ It is a WARNING and nothing was broken. The cost was SIGNAL: in a 12 h window
// it was **174 of ~250 runtime-error events**, so the surface an operator reads
// to answer "why is production erroring" was 70% noise.
//
// ⛔ `/api/wallet-backfill-ufc` genuinely executes Flow scripts and still needs
// the SDK. This guard is deliberately scoped to the route that does NOT — the
// fix removes roughly the larger share, not all of it.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

const ROUTE = join(process.cwd(), "app", "api", "cron", "ufc-enrichment-drain", "route.ts")

/**
 * The route's LIVE import specifiers.
 *
 * ⚠ Read from `import … from "…"` statements only, NOT by grepping the file for
 * the module name. This route's header explains the defect and names both
 * `wallet-backfill-helpers` and `@onflow/…` in prose, so a substring scan would
 * fire on its own documentation — a failure mode this repo has recorded
 * repeatedly. It also contains Cadence source with its own `import` lines
 * (`import NonFungibleToken from 0x…`), which have no quoted specifier and are
 * excluded by the same pattern.
 */
export function liveImportSpecifiers(src: string): string[] {
  return [...src.matchAll(/^\s*import\s[^\n]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1])
}

describe("ufc-enrichment-drain stays free of the Flow SDK", () => {
  const src = readFileSync(ROUTE, "utf8")

  it("parsed a plausible import list", () => {
    // Without this, a regex that matched nothing would make every ban below pass.
    const specs = liveImportSpecifiers(src)
    expect(specs.length).toBeGreaterThanOrEqual(3)
    expect(specs).toContain("next/server")
  })

  it("BAN AT ZERO — imports neither the Flow SDK nor the module that drags it in", () => {
    const offenders = liveImportSpecifiers(src).filter(
      (s) => s.includes("@onflow") || s.includes("wallet-backfill-helpers"),
    )
    expect(
      offenders,
      "This route needs one UUID string. Importing it from a module that pulls\n" +
        "@onflow/fcl put a DEP0169 `url.parse()` deprecation into every cold start —\n" +
        "299 events over 7 days, 70% of the runtime-error surface in a 12h window.\n" +
        "Take constants from `@/lib/collections` instead. Offending specifiers: ",
    ).toEqual([])
  })

  it("the UUID it now uses is the SAME one it used before", () => {
    // ⚠ The point of the change was to move WHERE the constant comes from, not
    // WHICH constant it is. This pins the value against the canonical table so a
    // silent drift — the whole collection reading under the wrong id — cannot
    // hide behind a green import guard.
    expect(COLLECTION_UUID_BY_SLUG.ufc).toBe("9b4824a8-736d-4a96-b450-8dcc0c46b023")
    expect(src).toContain("COLLECTION_UUID_BY_SLUG.ufc")
  })

  it("POSITIVE CONTROL — the detector sees a real Flow-SDK import", () => {
    const rolled = 'import fcl from "@onflow/fcl"\nimport { x } from "@/lib/y"'
    expect(liveImportSpecifiers(rolled).filter((s) => s.includes("@onflow"))).toEqual(["@onflow/fcl"])
  })

  it("NEGATIVE CONTROL — the banned names inside a COMMENT do not count", () => {
    // The shipped route explains the defect by naming both. A guard that fired on
    // its own explanation would train the next author to delete the explanation.
    const documented = [
      "// not from `wallet-backfill-helpers`, whose chain pulls @onflow/fcl",
      'import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"',
    ].join("\n")
    expect(
      liveImportSpecifiers(documented).filter(
        (s) => s.includes("@onflow") || s.includes("wallet-backfill-helpers"),
      ),
    ).toEqual([])
  })

  it("NEGATIVE CONTROL — an inline Cadence `import` is not a JS import", () => {
    // The route embeds a Cadence script containing `import NonFungibleToken from
    // 0x1d7e57aa55817448` — no quoted specifier, so it must not be parsed as one.
    const cadence = "import NonFungibleToken from 0x1d7e57aa55817448"
    expect(liveImportSpecifiers(cadence)).toEqual([])
  })
})
