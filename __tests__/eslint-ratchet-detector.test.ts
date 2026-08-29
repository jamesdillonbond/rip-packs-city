import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  countByRule,
  compareToBaseline,
  ratchetExitCode,
  BASELINE_PATH,
} from "@/scripts/check-eslint-ratchet.mjs"

// Guards the eslint ratchet. This repo does not run eslint in CI and ci.yml says
// so; measured 2026-08-29 that is a RULE-SET MISMATCH rather than neglect —
// 6,474 violations, 5,757 of them `no-explicit-any`, which is a documented
// convention here. The ratchet bounds the remaining 717 so they can only shrink.

const ROOT = join(__dirname, "..")
const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), "utf8"))

const report = (msgs: { ruleId: string | null }[][]) =>
  msgs.map((messages) => ({ filePath: "f", messages }))

describe("counting", () => {
  it("counts per rule and honours the exclusions", () => {
    const { counts } = countByRule(
      report([[{ ruleId: "a" }, { ruleId: "a" }, { ruleId: "skipme" }], [{ ruleId: "b" }]]),
      ["skipme"],
    )
    expect(counts).toEqual({ a: 2, b: 1 })
  })

  it("treats a null ruleId as an unused eslint-disable, NOT as a parse failure", () => {
    // My first reading of this report classified these as files eslint could not
    // parse, which would have been a much more alarming finding than it is.
    const { counts, suppressionsWithNothingToSuppress } = countByRule(
      report([[{ ruleId: null }, { ruleId: "a" }]]),
      [],
    )
    expect(counts).toEqual({ a: 1 })
    expect(suppressionsWithNothingToSuppress).toBe(1)
  })
})

describe("the ratchet decision", () => {
  const base = { a: 5, b: 2 }

  it("passes when counts hold or shrink", () => {
    expect(compareToBaseline({ counts: { a: 5, b: 2 }, baseline: base }).ok).toBe(true)
    expect(compareToBaseline({ counts: { a: 1, b: 2 }, baseline: base }).ok).toBe(true)
  })

  it("fails when a known rule grows", () => {
    const r = compareToBaseline({ counts: { a: 6, b: 2 }, baseline: base })
    expect(r.ok).toBe(false)
    expect(r.grew).toEqual([{ rule: "a", was: 5, now: 6 }])
  })

  it("fails when a rule NOT in the baseline appears", () => {
    // The blindness mode that matters: an unmeasured rule is not a pass. Without
    // this, enabling a new rule — or a plugin upgrade adding one — lands
    // silently and the ratchet quietly stops covering it.
    const r = compareToBaseline({ counts: { a: 5, b: 2, c: 1 }, baseline: base })
    expect(r.ok).toBe(false)
    expect(r.appeared).toEqual([{ rule: "c", now: 1 }])
  })

  it("reports a rule that reached zero so the baseline cannot describe the past", () => {
    const r = compareToBaseline({ counts: { a: 5 }, baseline: base })
    expect(r.ok).toBe(true) // shrinking never fails the build...
    expect(r.emptied).toEqual([{ rule: "b", was: 2 }]) // ...but it is surfaced
  })
})

describe("the exit code", () => {
  it("distinguishes 'eslint found nothing' from 'eslint did not run'", () => {
    // The two produce the same zero, and only one of them is good news.
    expect(ratchetExitCode({ ok: true, ran: true })).toBe(0)
    expect(ratchetExitCode({ ok: false, ran: true })).toBe(1)
    expect(ratchetExitCode({ ok: true, ran: false })).toBe(2)
  })
})

describe("the committed baseline", () => {
  it("excludes no-explicit-any at the RULE's granularity, not the plugin's", () => {
    // Muting @typescript-eslint wholesale would also silence
    // no-unused-expressions, no-require-imports and no-empty-object-type, which
    // are not conventional here and are in the baseline precisely so they stay
    // bounded.
    expect(baseline.excludedRules).toEqual(["@typescript-eslint/no-explicit-any"])
    const ruleNames = Object.keys(baseline.counts)
    expect(ruleNames).not.toContain("@typescript-eslint/no-explicit-any")
    expect(ruleNames.filter((r) => r.startsWith("@typescript-eslint/")).length).toBeGreaterThan(1)
  })

  it("is not vacuous — it bounds real rules, including correctness ones", () => {
    // A baseline of only style rules would pass forever while the classes that
    // actually break a page went unbounded.
    const names = Object.keys(baseline.counts)
    expect(names.length).toBeGreaterThan(10)
    expect(names).toContain("react-hooks/set-state-in-effect")
    expect(names).toContain("@next/next/no-html-link-for-pages")
    for (const n of Object.values(baseline.counts)) expect(n).toBeGreaterThan(0)
  })
})
