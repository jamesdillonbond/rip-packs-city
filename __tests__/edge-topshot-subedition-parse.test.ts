import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { decodeDict, clampInt } from "@/supabase/functions/_shared/topshot-subedition-parse"

// Pins backfill-topshot-subeditions' Cadence decode — the logic that turns a
// {UInt64: UInt32} on-chain response into subedition (parallel) CIRCULATION,
// which is a scarcity input into FMV / pack-EV. A decode bug that dropped or
// NaN'd a count would inject wrong scarcity into prices (worse than the honest
// NULL). Two layers: unit tests on the extracted pure logic + a source-drift
// guard against the deployed edge fn's inline copies (edge fns are outside the
// vitest coverage measure).

describe("decodeDict — {UInt64:UInt32} Dictionary → {id: count}", () => {
  const dict = (pairs: Array<[string, string]>) => ({
    type: "Dictionary",
    value: pairs.map(([k, v]) => ({ key: { value: k }, value: { value: v } })),
  })

  it("unwraps a well-formed dictionary to numeric counts", () => {
    expect(decodeDict(dict([["101", "3"], ["102", "12"]]))).toEqual({ "101": 3, "102": 12 })
  })

  it("returns {} for a non-Dictionary node", () => {
    expect(decodeDict({ type: "Array", value: [] })).toEqual({})
    expect(decodeDict(null)).toEqual({})
    expect(decodeDict("nope")).toEqual({})
  })

  it("returns {} when the value array is missing", () => {
    expect(decodeDict({ type: "Dictionary" })).toEqual({})
  })

  it("skips an entry whose value is non-numeric (never NaN into a circulation column)", () => {
    const out = decodeDict(dict([["101", "5"], ["102", "not-a-number"]]))
    expect(out).toEqual({ "101": 5 })
    expect("102" in out).toBe(false)
  })

  it("skips an entry with an empty key", () => {
    expect(decodeDict(dict([["", "5"], ["103", "7"]]))).toEqual({ "103": 7 })
  })
})

describe("clampInt — bounded integer coercion", () => {
  it("clamps within [lo, hi] and floors fractionals", () => {
    expect(clampInt(50000, 1, 50000)).toBe(50000)
    expect(clampInt(60000, 1, 50000)).toBe(50000)
    expect(clampInt(0, 1, 50000)).toBe(1)
    expect(clampInt(20.9, 1, 50000)).toBe(20)
  })
  it("maps any non-finite input to lo (never writes NaN — Infinity is NOT finite)", () => {
    expect(clampInt(NaN, 1, 50000)).toBe(1)
    expect(clampInt(Infinity, 1, 50000)).toBe(1)
    expect(clampInt(-Infinity, 5, 9)).toBe(5)
  })
})

describe("edge-fn source-drift guard — backfill-topshot-subeditions inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/backfill-topshot-subeditions/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/topshot-subedition-parse/.test(edgeSrc)

  const DICT_GUARD = norm('if (d.type !== "Dictionary" || !Array.isArray(d.value)) return out;')
  const FINITE_GUARD = norm("if (k && Number.isFinite(v)) out[k] = v;")
  const CLAMP = norm("return Math.max(lo, Math.min(hi, Math.floor(n)));")

  it.each([
    ["Dictionary type guard", DICT_GUARD],
    ["finite-value guard", FINITE_GUARD],
    ["clampInt floor/min/max", CLAMP],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
