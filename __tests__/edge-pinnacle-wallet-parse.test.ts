import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { unwrap, b64ToUtf8 } from "@/supabase/functions/_shared/pinnacle-wallet-parse"

// Pins scan-pinnacle-wallet's on-chain decode — the Cadence-JSON unwrap + the
// mojibake guard that together decide what NFT data comes back from a Pinnacle
// wallet walk. This edge fn had ZERO test reference before this file.

const b64Utf8 = (s: string) => btoa(unescape(encodeURIComponent(s)))

describe("b64ToUtf8 — mojibake guard", () => {
  it("round-trips accented character names without double-encoding", () => {
    for (const s of ["Moana", "Wall-E", "Ratatouille — Rémy", "Piñata"]) {
      expect(b64ToUtf8(b64Utf8(s))).toBe(s)
    }
  })
  it("differs from a latin1 atob on multi-byte input", () => {
    const enc = b64Utf8("Rémy")
    expect(b64ToUtf8(enc)).toBe("Rémy")
    expect(atob(enc)).not.toBe("Rémy")
  })
})

describe("unwrap — typed Cadence JSON → plain JS", () => {
  it("unwraps primitives and passes through non-typed values", () => {
    expect(unwrap({ type: "UInt64", value: "42" })).toBe("42") // default: raw value
    expect(unwrap({ type: "String", value: "hi" })).toBe("hi")
    expect(unwrap(5)).toBe(5)
    expect(unwrap(null)).toBeNull()
    expect(unwrap(undefined)).toBeUndefined()
  })
  it("Optional: null → null, present → unwrapped", () => {
    expect(unwrap({ type: "Optional", value: null })).toBeNull()
    expect(unwrap({ type: "Optional", value: { type: "String", value: "x" } })).toBe("x")
  })
  it("Array maps element-wise", () => {
    expect(
      unwrap({ type: "Array", value: [{ type: "Int", value: "1" }, { type: "Int", value: "2" }] }),
    ).toEqual(["1", "2"])
  })
  it("Dictionary → keyed object (keys stringified)", () => {
    const d = {
      type: "Dictionary",
      value: [{ key: { type: "String", value: "k" }, value: { type: "String", value: "v" } }],
    }
    expect(unwrap(d)).toEqual({ k: "v" })
  })
  it("Struct/Resource/Event/Contract/Enum flatten by field name", () => {
    for (const type of ["Struct", "Resource", "Event", "Contract", "Enum"]) {
      const node = {
        type,
        value: { fields: [{ name: "editionKey", value: { type: "String", value: "1:base:1" } }] },
      }
      expect(unwrap(node)).toEqual({ editionKey: "1:base:1" })
    }
  })
  it("a Struct with no fields → empty object, never throws", () => {
    expect(unwrap({ type: "Struct", value: {} })).toEqual({})
  })
  it("nested: an Optional Struct inside an Array", () => {
    const node = {
      type: "Array",
      value: [
        { type: "Optional", value: { type: "Struct", value: { fields: [{ name: "id", value: { type: "UInt64", value: "7" } }] } } },
        { type: "Optional", value: null },
      ],
    }
    expect(unwrap(node)).toEqual([{ id: "7" }, null])
  })
})

describe("edge-fn source-drift guard — scan-pinnacle-wallet inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/scan-pinnacle-wallet/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/pinnacle-wallet-parse/.test(edgeSrc)
  const DECODE = norm('new TextDecoder("utf-8").decode(bytes)')
  const OPTIONAL = norm('case "Optional": return value === null ? null : unwrap(value)')
  const STRUCT = norm('case "Struct": case "Resource": case "Event": case "Contract": case "Enum":')

  it.each([
    ["utf-8 decode", DECODE],
    ["Optional case", OPTIONAL],
    ["struct-family case", STRUCT],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
