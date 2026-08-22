import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// The live "concierge answers rather than returning a fallback" probe: the ONLY
// hard check that would have caught the fourteen-day concierge outage.
//
// ⚠ WHY IT EXISTS. The concierge — RPC's flagship differentiator — returned a
// fallback on essentially every call from ~2026-08-02 and every instrument read
// green until Trevor found it by using the product. Two prior attempts missed:
//   · the other live probes assert CONTENT (Pinnacle results, a LeBron mention)
//     and are therefore correctly SOFT — model output is flaky and an empty
//     result can be a true answer. A soft check never pages.
//   · the degraded-share outcome check counts real degraded conversations, which
//     is right and is now honest, but real concierge traffic is ~0–3/day so it
//     sits below its sample floor and returns no verdict.
//
// ⚠ THE TWO PROPERTIES PINNED HERE ARE A SPLIT, AND THE SPLIT IS THE WHOLE POINT:
//   1. a DEGRADED CATEGORY is a HARD fail — decisive, unambiguous, not
//      model-dependent, and exactly the shape of the outage;
//   2. a TRANSPORT failure (throw / non-2xx / unparseable) is SOFT — from inside
//      the probe we cannot tell our own outage from a network blip, and
//      scripts/smoke-gate.py keys on `soft`, so a hard fail there would page on a
//      hiccup. This repo has already paid for that (`ufc_fmv_stale_hours`).
//
// Collapsing either direction breaks it: make (2) hard and it cries wolf until
// someone marks the whole check soft; make (1) soft and it is decorative — which
// is precisely the state that let the outage run for a fortnight.
//
// ⚠ SOURCE-level, and it strips comments first. The block above names every
// degraded category and the word `soft` many times, so a raw grep would pass on
// the prose alone with the code deleted — the bug this repo has shipped ≥6 times.
// ─────────────────────────────────────────────────────────────────────────────

const ROUTE = join(process.cwd(), "app", "api", "smoke-test", "route.ts")
const WORKFLOW = join(process.cwd(), ".github", "workflows", "smoke-tests.yml")

/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy here stripped BLOCK comments before LINE comments, so an
 * ordinary line comment mentioning a glob path opened a block comment that ran
 * to the next close-comment anywhere in the file, blanking real source this
 * guard then reported as clean (103,590 chars across 49 product files).
 * Do not re-inline a local copy.
 */

/** The probe's implementation block, comments blanked. */
function probeBlock(src: string): string {
  const code = stripComments(src)
  const i = code.indexOf('"concierge answers rather than returning a fallback (live)"')
  expect(i, "live concierge answer probe is missing").toBeGreaterThan(-1)
  // Through to its trailing meta restatement (the `time()` second argument).
  const last = code.lastIndexOf('"concierge answers rather than returning a fallback (live)"')
  return code.slice(i, last + 200)
}

describe("live concierge answer probe", () => {
  const src = readFileSync(ROUTE, "utf8")

  it("is HARD on a degraded category — no soft flag on the verdict path", () => {
    const block = probeBlock(src)
    // The verdict is `passed: !degraded`; if that line carried `soft: true` the
    // check could never page, which is the state that hid the outage.
    expect(block).toContain("passed: !degraded")
    const verdictIdx = block.indexOf("passed: !degraded")
    const verdictStmt = block.slice(verdictIdx, block.indexOf("}", verdictIdx))
    expect(
      /soft:\s*true/.test(verdictStmt),
      "the degraded verdict must NOT be soft — a soft fail never reaches the gate",
    ).toBe(false)
  })

  it("is SOFT on every transport failure, so a network blip cannot page", () => {
    const block = probeBlock(src)
    // Three inconclusive exits: throw, non-2xx, unparseable body.
    const softExits = block.match(/soft:\s*true,\s*couldNotRun:\s*true/g) ?? []
    expect(
      softExits.length,
      "expected 3 soft+couldNotRun exits (throw / non-2xx / unparseable)",
    ).toBe(3)
  })

  it("keys on CATEGORY, not on the user-facing fallback copy", () => {
    const block = probeBlock(src)
    expect(block).toContain("concierge_unavailable")
    expect(block).toContain("parsed?.category")
    // Copy gets reworded; a check keyed to it goes vacuous while still green.
    expect(/temporarily\s+unavailable/i.test(block)).toBe(false)
  })

  it("GUARDS THE GUARD: prose alone does not satisfy it", () => {
    // Delete the verdict but keep every comment — the regression this exists for.
    const mutated = src.replace("passed: !degraded", "passed: true")
    expect(mutated).not.toBe(src)
    expect(mutated).toContain("concierge_unavailable") // still there, in prose + array
    expect(() => {
      const block = probeBlock(mutated)
      expect(block).toContain("passed: !degraded")
    }).toThrow()
  })

  it("the scheduled workflow arms it, and push events deliberately do NOT", () => {
    // ⚠ This workflow also triggers on every push to main. With concurrent
    // sessions pushing every couple of minutes, an unconditional ?concierge=1
    // would be ~720 real Anthropic calls/day — the cost that makes a check
    // optional, and an optional check is not a monitor.
    const wf = readFileSync(WORKFLOW, "utf8")
    expect(wf).toContain("concierge=1")
    expect(
      /github\.event_name\s*\}\}"?\s*!=\s*"push"/.test(wf),
      "the live probe must be gated OFF for push events",
    ).toBe(true)
    // And it must still be reachable on the daily schedule.
    expect(wf).toMatch(/schedule:/)
  })
})
