import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { unwrapCdcReduced, toSerial } from "@/supabase/functions/_shared/cdc-reduced"
import { unwrapCdc } from "@/supabase/functions/_shared/cdc"

// Coverage for the REDUCED JSON-CDC unwrapper shared (by shape) across the three
// serial-backfill edge fns. The load-bearing invariant is that this variant does
// NOT flatten composite CDC types — its default arm returns the raw `value` — so
// it must stay distinct from the FULL _shared/cdc.ts. The source-drift guard at
// the bottom pins that the three inline copies still carry the reduced shape.

describe("unwrapCdcReduced — scalars, Optional, Array, Dictionary", () => {
  it("passes primitives through unchanged", () => {
    expect(unwrapCdcReduced(null)).toBeNull()
    expect(unwrapCdcReduced(undefined)).toBeUndefined()
    expect(unwrapCdcReduced(42)).toBe(42)
    expect(unwrapCdcReduced("x")).toBe("x")
  })

  it("unwraps a scalar CDC value to its inner value", () => {
    expect(unwrapCdcReduced({ type: "UInt64", value: "123" })).toBe("123")
    expect(unwrapCdcReduced({ type: "Address", value: "0xabc" })).toBe("0xabc")
  })

  it("unwraps Optional to null or the inner value", () => {
    expect(unwrapCdcReduced({ type: "Optional", value: null })).toBeNull()
    expect(unwrapCdcReduced({ type: "Optional", value: { type: "UInt64", value: "7" } })).toBe("7")
  })

  it("unwraps Array element-wise", () => {
    const cdc = { type: "Array", value: [{ type: "UInt64", value: "1" }, { type: "UInt64", value: "2" }] }
    expect(unwrapCdcReduced(cdc)).toEqual(["1", "2"])
  })

  it("unwraps Dictionary into a plain object keyed by unwrapped keys", () => {
    const cdc = {
      type: "Dictionary",
      value: [
        { key: { type: "String", value: "serial" }, value: { type: "UInt64", value: "9" } },
        { key: { type: "String", value: "edition" }, value: { type: "UInt64", value: "5" } },
      ],
    }
    expect(unwrapCdcReduced(cdc)).toEqual({ serial: "9", edition: "5" })
  })

  it("returns raw .value for a composite type (Struct/Event) — the REDUCED behavior", () => {
    // A Struct's fields are NOT flattened here; the full _shared/cdc.ts WOULD
    // flatten them. This is the deliberate divergence this variant exists for.
    const struct = {
      type: "Struct",
      value: { id: "s1", fields: [{ name: "serial", value: { type: "UInt64", value: "3" } }] },
    }
    const reduced = unwrapCdcReduced(struct) as any
    // reduced: returns the raw value object, fields NOT flattened to { serial: "3" }
    expect(reduced.fields).toBeDefined()
    expect(reduced.serial).toBeUndefined()

    // ...whereas the full unwrapCdc flattens the same struct to a keyed object.
    const full = unwrapCdc(struct) as any
    expect(full.serial).toBe("3")
    expect(full.fields).toBeUndefined()
  })

  it("returns the node itself when type/value are not both present", () => {
    expect(unwrapCdcReduced({ foo: "bar" })).toEqual({ foo: "bar" })
  })
})

describe("toSerial — positive-serial coercion", () => {
  it("coerces a positive number/string to a number", () => {
    expect(toSerial(5)).toBe(5)
    expect(toSerial("42")).toBe(42)
  })
  it("rejects 0, negatives, non-finite and nullish (serials are 1-based)", () => {
    expect(toSerial(0)).toBeNull()
    expect(toSerial(-3)).toBeNull()
    expect(toSerial("nope")).toBeNull()
    expect(toSerial(null)).toBeNull()
    expect(toSerial(undefined)).toBeNull()
    expect(toSerial(Infinity)).toBeNull()
  })
})

describe("source-drift guard — the three inline copies stay REDUCED (no composite flattening)", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const read = (name: string) =>
    norm(readFileSync(path.join(root, `supabase/functions/${name}/index.ts`), "utf8"))

  // The reduced signature fragments (normalized). Each inline copy must carry the
  // Optional/Array/Dictionary arms AND a bare `default: return value` — and must
  // NOT have grown a Struct/Event flattening case (that would make it the full
  // variant and change composite handling).
  const OPTIONAL = norm('case "Optional": return value === null ? null : unwrapCdc(value)')
  const DEFAULT_VALUE = norm("default: return value")
  const STRUCT = norm('case "Struct":')

  for (const fn of ["sales-serial-backfill", "backfill-allday-listing-serials", "scan-ufc-wallet"]) {
    it(`${fn} still carries the reduced unwrapCdc (Optional arm + default→value, no Struct case)`, () => {
      const src = read(fn)
      expect(src.includes(OPTIONAL)).toBe(true)
      expect(src.includes(DEFAULT_VALUE)).toBe(true)
      expect(src.includes(STRUCT)).toBe(false)
    })
  }

  it("the _shared mirror matches the reduced shape and the full cdc.ts does NOT (they must stay distinct)", () => {
    const mirror = norm(readFileSync(path.join(root, "supabase/functions/_shared/cdc-reduced.ts"), "utf8"))
    const full = norm(readFileSync(path.join(root, "supabase/functions/_shared/cdc.ts"), "utf8"))
    // mirror carries the reduced default→value arm and no Struct flattening
    expect(mirror.includes(norm("default: return value"))).toBe(true)
    // the full variant DOES flatten Struct — proving they are different functions
    expect(full.includes(norm('case "Struct":'))).toBe(true)
  })
})
