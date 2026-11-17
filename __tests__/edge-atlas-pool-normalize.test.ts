import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { num, normalizeAtlas } from "@/supabase/functions/_shared/atlas-pool-normalize"

// Pins ingest-topshot-atlas-pool's normalizer — the logic that turns a raw Atlas
// GetDistributionEditions response into the canonical drop-pool rows pack-EV
// weights every edition against. A bug that mis-read `remaining` (the survivor
// weight) or accepted a wrong-shaped envelope as data would skew every pack's EV
// (the fabricated-EV class). The kind discriminator MUST keep an empty-but-well-
// formed envelope distinct from an unrecognised shape, or a schema change writes
// zeros silently. Two layers: unit tests + a source-drift guard (edge fns are
// outside the coverage measure).

describe("num — finite-or-null coercion", () => {
  it("coerces finite numbers and numeric strings", () => {
    expect(num(5)).toBe(5)
    expect(num("42")).toBe(42)
    expect(num(0)).toBe(0)
  })
  it("maps null/undefined/false/NaN to null", () => {
    expect(num(null)).toBeNull()
    expect(num(undefined)).toBeNull()
    expect(num(false)).toBeNull()
    expect(num("nope")).toBeNull()
    expect(num(Infinity)).toBeNull()
  })
})

describe("normalizeAtlas — canonical drop-pool rows", () => {
  const edition = (setId: number, tplId: number, remaining: number, original: number) => ({
    editionId: `${setId}:${tplId}`,
    originalCount: original,
    remainingCount: remaining,
    edition: { setId, editionTemplateId: tplId },
  })

  it("maps the confirmed Atlas shape to {set,play,remaining,original}", () => {
    const res = normalizeAtlas({ editions: [edition(100, 5, 30, 120)], totalCount: 1 })
    expect(res.kind).toBe("ok")
    expect(res.rows).toEqual([{ set: 100, play: 5, remaining: 30, original: 120 }])
    expect(res.totalCount).toBe(1)
  })

  it("classifies a well-formed but empty editions array as 'empty' (a normal no-pool dist)", () => {
    const res = normalizeAtlas({ editions: [], totalCount: 0 })
    expect(res.kind).toBe("empty")
    expect(res.rows).toBeNull()
    // empty must NOT be conflated with unmapped — the caller writes nothing but does not alarm.
  })

  it("classifies an unrecognised shape as 'unmapped' and surfaces the keys", () => {
    const res = normalizeAtlas({ foo: "bar", baz: 1 })
    expect(res.kind).toBe("unmapped")
    expect(res.sampleKeys).toEqual(["foo", "baz"])
  })

  it("reads the data.editions envelope variant", () => {
    const res = normalizeAtlas({ data: { editions: [edition(9, 9, 1, 1)], totalCount: 3 } })
    expect(res.kind).toBe("ok")
    expect(res.rows?.[0]).toEqual({ set: 9, play: 9, remaining: 1, original: 1 })
    expect(res.totalCount).toBe(3)
  })

  it("honours legacy fallback keys (setFlowId/playFlowId/remaining_count)", () => {
    const res = normalizeAtlas({ editions: [{ setFlowId: 7, playFlowId: 8, remaining_count: 4, original_count: 10 }] })
    expect(res.rows?.[0]).toEqual({ set: 7, play: 8, remaining: 4, original: 10 })
  })

  it("skips a row missing set/play/remaining rather than fabricating one; all-skipped → unmapped", () => {
    const res = normalizeAtlas({ editions: [{ edition: { setId: 1 } /* no play, no remaining */ }] })
    expect(res.kind).toBe("unmapped")
    expect(res.rows).toBeNull()
  })

  it("defaults a missing original to 0 (never null in a row)", () => {
    const res = normalizeAtlas({ editions: [{ edition: { setId: 1, editionTemplateId: 2 }, remainingCount: 5 }] })
    expect(res.rows?.[0]).toEqual({ set: 1, play: 2, remaining: 5, original: 0 })
  })

  it("keeps remaining=0 as a real row (a depleted edition is data, not a skip)", () => {
    const res = normalizeAtlas({ editions: [edition(1, 2, 0, 50)] })
    expect(res.kind).toBe("ok")
    expect(res.rows?.[0].remaining).toBe(0)
  })
})

describe("edge-fn source-drift guard — ingest-topshot-atlas-pool inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/ingest-topshot-atlas-pool/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/atlas-pool-normalize/.test(edgeSrc)

  const NUM_GUARD = norm("if (v == null || v === false) return null")
  const EMPTY_KIND = norm('return { kind: "empty", rows: null, sampleKeys: raw ? Object.keys(raw) : [], totalCount }')
  const REMAINING = norm("const remaining = num(e.remainingCount) ?? num(e.remaining_count) ?? num(e.remaining)")
  const SKIP_GUARD = norm("if (set == null || play == null || remaining == null) continue")

  it.each([
    ["num null guard", NUM_GUARD],
    ["empty-kind discriminator", EMPTY_KIND],
    ["remaining fallback chain", REMAINING],
    ["incomplete-row skip", SKIP_GUARD],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
