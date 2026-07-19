import { describe, it, expect } from "vitest"
import { unwrapCdc, extractTypeId } from "../workers/pack-events-ingest/cdc"

// Pins the pack-events-ingest Cadence JSON-CDC decoder. This turns every pack
// purchase/open event payload into plain JS; a wrong branch here (Optional,
// Dictionary, nested Struct, the vault staticType) silently corrupts
// pack_purchases, so each JSON-CDC shape is asserted.

describe("unwrapCdc — scalar + wrapper types", () => {
  it("passes through primitives and non-CDC values untouched", () => {
    expect(unwrapCdc(null)).toBeNull()
    expect(unwrapCdc(undefined)).toBeUndefined()
    expect(unwrapCdc(42)).toBe(42)
    expect(unwrapCdc("plain")).toBe("plain")
  })

  it("unwraps scalar CDC types to their .value", () => {
    expect(unwrapCdc({ type: "String", value: "hi" })).toBe("hi")
    expect(unwrapCdc({ type: "Address", value: "0xabc" })).toBe("0xabc")
    expect(unwrapCdc({ type: "Bool", value: true })).toBe(true)
    // The whole Int/UInt/Word/Fix family returns the raw string value (unparsed).
    expect(unwrapCdc({ type: "UInt64", value: "123" })).toBe("123")
    expect(unwrapCdc({ type: "UFix64", value: "1.50000000" })).toBe("1.50000000")
  })

  it("unwraps Optional: null → null, present → the inner unwrapped value", () => {
    expect(unwrapCdc({ type: "Optional", value: null })).toBeNull()
    expect(unwrapCdc({ type: "Optional", value: { type: "Address", value: "0x1" } })).toBe("0x1")
  })

  it("falls through unknown CDC types to the raw value", () => {
    expect(unwrapCdc({ type: "SomethingNew", value: "raw" })).toBe("raw")
  })
})

describe("unwrapCdc — composites", () => {
  it("unwraps Array element-wise", () => {
    const cdc = { type: "Array", value: [{ type: "UInt64", value: "1" }, { type: "UInt64", value: "2" }] }
    expect(unwrapCdc(cdc)).toEqual(["1", "2"])
  })

  it("unwraps Dictionary into a keyed object", () => {
    const cdc = {
      type: "Dictionary",
      value: [
        { key: { type: "String", value: "a" }, value: { type: "UInt64", value: "10" } },
        { key: { type: "String", value: "b" }, value: { type: "Optional", value: null } },
      ],
    }
    expect(unwrapCdc(cdc)).toEqual({ a: "10", b: null })
  })

  it("unwraps Struct/Event/Resource fields by name (recursively)", () => {
    const event = {
      type: "Event",
      value: {
        id: "A.x.PackNFT.Deposit",
        fields: [
          { name: "id", value: { type: "UInt64", value: "77" } },
          { name: "to", value: { type: "Optional", value: { type: "Address", value: "0xbuyer" } } },
          {
            name: "meta",
            value: { type: "Struct", value: { fields: [{ name: "n", value: { type: "String", value: "deep" } }] } },
          },
        ],
      },
    }
    expect(unwrapCdc(event)).toEqual({ id: "77", to: "0xbuyer", meta: { n: "deep" } })
  })

  it("tolerates a fields-less composite (empty object)", () => {
    expect(unwrapCdc({ type: "Struct", value: {} })).toEqual({})
  })

  it("returns the node as-is when it is an object without a type/value pair", () => {
    expect(unwrapCdc({ foo: 1 })).toEqual({ foo: 1 })
  })
})

describe("extractTypeId — vault static type id", () => {
  it("returns a bare string type id", () => {
    expect(extractTypeId("A.f.FlowToken.Vault")).toBe("A.f.FlowToken.Vault")
  })

  it("reads staticType when it is a string", () => {
    expect(extractTypeId({ staticType: "A.f.FiatToken.Vault" })).toBe("A.f.FiatToken.Vault")
  })

  it("reads staticType.typeID when staticType is an object", () => {
    expect(extractTypeId({ staticType: { typeID: "A.f.DapperUtilityCoin.Vault", kind: "Resource" } })).toBe(
      "A.f.DapperUtilityCoin.Vault",
    )
  })

  it("returns undefined for shapes that carry no type id", () => {
    expect(extractTypeId(undefined)).toBeUndefined()
    expect(extractTypeId(null)).toBeUndefined()
    expect(extractTypeId(123)).toBeUndefined()
    expect(extractTypeId({ staticType: { kind: "Resource" } })).toBeUndefined()
  })
})
