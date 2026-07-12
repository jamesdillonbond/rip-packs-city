import { describe, it, expect } from "vitest"
import { unwrapCdc } from "@/supabase/functions/_shared/cdc"

// Unit tests for the recursive JSON-CDC tree unwrapper shared across the Flow
// event-ingest edge functions. A wrong Optional / typed / container unwrap
// silently drops ids and starves a backfill, so every container kind is pinned
// here with hand-built JSON-CDC nodes.

// ── JSON-CDC node builders (mirror __tests__/dapper-v1-tx-decode.test.ts) ──────
const optional = (node: unknown) => ({ type: "Optional", value: node })
const uint64 = (n: number | string) => ({ type: "UInt64", value: String(n) })
const addr = (a: string) => ({ type: "Address", value: a })
const bool = (b: boolean) => ({ type: "Bool", value: b })
const arr = (nodes: unknown[]) => ({ type: "Array", value: nodes })
const struct = (fields: Array<[string, unknown]>) => ({
  type: "Struct",
  value: { id: "s", fields: fields.map(([name, value]) => ({ name, value })) },
})
const dict = (pairs: Array<[unknown, unknown]>) => ({
  type: "Dictionary",
  value: pairs.map(([key, value]) => ({ key, value })),
})

describe("unwrapCdc — Optional", () => {
  it("unwraps a filled Optional to its inner primitive", () => {
    expect(unwrapCdc(optional(uint64(123)))).toBe("123")
  })

  it("unwraps Optional(null) to null", () => {
    expect(unwrapCdc(optional(null))).toBeNull()
  })

  it("unwraps a doubly-nested Optional", () => {
    expect(unwrapCdc(optional(optional(addr("0xabc"))))).toBe("0xabc")
  })
})

describe("unwrapCdc — primitives pass through their string/scalar value", () => {
  it("returns the raw value for a typed scalar (default case)", () => {
    expect(unwrapCdc(uint64(42))).toBe("42")
    expect(unwrapCdc(addr("0xdeadbeef"))).toBe("0xdeadbeef")
    expect(unwrapCdc(bool(true))).toBe(true)
  })

  it("passes a bare non-object node straight through", () => {
    expect(unwrapCdc("plain")).toBe("plain")
    expect(unwrapCdc(7)).toBe(7)
    expect(unwrapCdc(null)).toBeNull()
    expect(unwrapCdc(undefined)).toBeUndefined()
  })
})

describe("unwrapCdc — Struct / Resource / Event collapse fields to a keyed object", () => {
  it("collapses struct fields into a plain object, recursing into each value", () => {
    const node = struct([
      ["id", uint64(9)],
      ["to", optional(addr("0xbuyer"))],
      ["active", bool(false)],
      ["missing", optional(null)],
    ])
    expect(unwrapCdc(node)).toEqual({
      id: "9",
      to: "0xbuyer",
      active: false,
      missing: null,
    })
  })

  it("treats Resource / Event / Contract / Enum the same as Struct", () => {
    for (const type of ["Resource", "Event", "Contract", "Enum"]) {
      const node = { type, value: { fields: [{ name: "n", value: uint64(1) }] } }
      expect(unwrapCdc(node)).toEqual({ n: "1" })
    }
  })

  it("yields an empty object when a struct has no fields array", () => {
    expect(unwrapCdc({ type: "Struct", value: { id: "x" } })).toEqual({})
  })
})

describe("unwrapCdc — Dictionary becomes a string-keyed object", () => {
  it("maps each key/value pair, stringifying the unwrapped key", () => {
    const node = dict([
      [{ type: "String", value: "alpha" }, uint64(1)],
      [{ type: "String", value: "beta" }, optional(addr("0xb"))],
    ])
    expect(unwrapCdc(node)).toEqual({ alpha: "1", beta: "0xb" })
  })
})

describe("unwrapCdc — Array maps element-wise", () => {
  it("unwraps a typed CDC Array node element-by-element", () => {
    expect(unwrapCdc(arr([uint64(1), uint64(2), optional(null)]))).toEqual(["1", "2", null])
  })

  it("unwraps a bare JS array (top-level, no type wrapper)", () => {
    expect(unwrapCdc([uint64(1), addr("0xa")])).toEqual(["1", "0xa"])
  })
})

describe("unwrapCdc — Type node keeps only the staticType", () => {
  it("projects a Type node down to { staticType }", () => {
    expect(unwrapCdc({ type: "Type", value: { staticType: "A.foo.Bar" } })).toEqual({
      staticType: "A.foo.Bar",
    })
  })
})

describe("unwrapCdc — a realistic nested event payload", () => {
  it("fully collapses an Event carrying an Optional, a nested Struct, and a Dictionary", () => {
    const event = {
      type: "Event",
      value: {
        id: "A.e4cf4bdc1751c65d.AllDay.MomentNFTMinted",
        fields: [
          ["momentId", uint64(1001)],
          ["owner", optional(addr("0xowner00000000"))],
          [
            "edition",
            struct([
              ["editionID", uint64(55)],
              ["serial", uint64(3)],
            ]),
          ],
          ["traits", dict([[{ type: "String", value: "rookie" }, bool(true)]])],
        ].map(([name, value]) => ({ name, value })),
      },
    }
    expect(unwrapCdc(event)).toEqual({
      momentId: "1001",
      owner: "0xowner00000000",
      edition: { editionID: "55", serial: "3" },
      traits: { rookie: true },
    })
  })
})
