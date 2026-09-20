import { describe, it, expect } from "vitest"
import {
  extractScriptResultB64,
  parseAddressArray,
  type CdcNode,
} from "../supabase/functions/_shared/hybrid-custody-probe-decode"

// Unit tests for the HybridCustody probe decoders — the reply path of
// hybrid-custody-backfill, which until now had NOTHING a test could reach
// (`__tests__/edge-functions-have-reachable-tests-ratchet.test.ts`).
//
// ⚠ Both functions fail to an EMPTY value rather than to an error, so the cases
// that matter are the ones separating "read succeeded and found nothing" from
// "read succeeded and we could not understand it". A wrong branch here reports
// an account with linked children as an account with none.

describe("extractScriptResultB64 — the Flow REST /v1/scripts shape sniffer", () => {
  it("returns a bare base64 body unchanged (the raw shape)", () => {
    expect(extractScriptResultB64("eyJhIjoxfQ==")).toBe("eyJhIjoxfQ==")
  })

  it("trims surrounding whitespace before deciding", () => {
    expect(extractScriptResultB64("  eyJhIjoxfQ==\n")).toBe("eyJhIjoxfQ==")
  })

  it("unwraps the JSON-object shape { value: <base64> }", () => {
    expect(extractScriptResultB64('{"value":"eyJhIjoxfQ=="}')).toBe("eyJhIjoxfQ==")
  })

  it("unwraps the JSON-STRING shape, which starts with a quote not a brace", () => {
    // This is why the branch tests for `"` as well as `{`. A bare JSON string
    // is valid JSON and parses to a string.
    expect(extractScriptResultB64('"eyJhIjoxfQ=="')).toBe("eyJhIjoxfQ==")
  })

  it("returns null for an EMPTY body — nothing was returned at all", () => {
    expect(extractScriptResultB64("")).toBeNull()
    expect(extractScriptResultB64("   \n ")).toBeNull()
  })

  it("returns null for JSON of an UNEXPECTED shape rather than guessing", () => {
    // `{ "foo": 1 }` parses, but carries no base64. Returning the raw text here
    // would hand a JSON blob to atob() downstream.
    expect(extractScriptResultB64('{"foo":1}')).toBeNull()
    expect(extractScriptResultB64('{"value":123}')).toBeNull()
  })

  it("falls back to raw base64 when a brace-leading body is NOT valid JSON", () => {
    // The catch branch: looked like JSON, was not. The documented fallback is
    // to treat it as base64 rather than to fail.
    expect(extractScriptResultB64("{not json")).toBe("{not json")
  })
})

describe("parseAddressArray — Cadence Address[] decode", () => {
  const addr = (value: unknown): CdcNode => ({ type: "Address", value })

  it("extracts every Address child in order", () => {
    const node: CdcNode = { type: "Array", value: [addr("0xaaa"), addr("0xbbb")] }
    expect(parseAddressArray(node)).toEqual(["0xaaa", "0xbbb"])
  })

  it("returns [] for a genuinely empty Array — a real 'no children'", () => {
    expect(parseAddressArray({ type: "Array", value: [] })).toEqual([])
  })

  it("returns [] for a MISSING node", () => {
    expect(parseAddressArray(undefined)).toEqual([])
  })

  it("returns [] when the node is not an Array type", () => {
    expect(parseAddressArray({ type: "Optional", value: [addr("0xaaa")] })).toEqual([])
  })

  it("returns [] when value is not an array, even with the right type tag", () => {
    expect(parseAddressArray({ type: "Array", value: "0xaaa" })).toEqual([])
  })

  it("SKIPS non-Address children rather than coercing them", () => {
    const node: CdcNode = {
      type: "Array",
      value: [addr("0xaaa"), { type: "String", value: "0xbbb" }, addr("0xccc")],
    }
    expect(parseAddressArray(node)).toEqual(["0xaaa", "0xccc"])
  })

  it("SKIPS an Address whose value is not a string", () => {
    const node: CdcNode = { type: "Array", value: [addr(123), addr(null), addr("0xaaa")] }
    expect(parseAddressArray(node)).toEqual(["0xaaa"])
  })

  it("tolerates null/primitive children without throwing", () => {
    const node: CdcNode = { type: "Array", value: [null, 7, "x", addr("0xaaa")] }
    expect(parseAddressArray(node)).toEqual(["0xaaa"])
  })

  // ⚠ The non-vacuity control: these cases must be able to FAIL. A parser that
  // always returned [] would pass every emptiness case above, so at least one
  // case must assert a NON-empty result — and one does, first.
  it("is not vacuous: the happy path returns a non-empty result", () => {
    expect(parseAddressArray({ type: "Array", value: [addr("0xaaa")] }).length).toBeGreaterThan(0)
  })
})
