import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { extractEditionKey } from "@/supabase/functions/_shared/pinnacle-edition-key"

// Pins pinnacle-nft-resolver's edition-key decode — the string that maps a
// Disney Pinnacle NFT to a `pinnacle_editions` row. This edge fn had ZERO test
// reference before this file. A wrong unwrap silently drops a real pin (null) or
// could attach the wrong edition, so every wrapper shape needs a pin.

// Helper: build the Flow-REST-decoded struct envelope Pinnacle returns.
const structWith = (fields: Array<{ name: string; value: unknown }>) => ({
  type: "Struct",
  value: { fields },
})
const optional = (v: unknown) => ({ type: "Optional", value: v })
const str = (s: string) => ({ type: "String", value: s })

describe("extractEditionKey — Optional-in-Struct descent", () => {
  it("reads editionKey wrapped in an Optional", () => {
    const raw = structWith([{ name: "editionKey", value: optional(str("13:standard:1")) }])
    expect(extractEditionKey(raw)).toBe("13:standard:1")
  })
  it("reads a bare (non-Optional) editionKey value", () => {
    const raw = structWith([{ name: "editionKey", value: str("9:chase:2") }])
    expect(extractEditionKey(raw)).toBe("9:chase:2")
  })
  it("ignores other fields and finds editionKey among them", () => {
    const raw = structWith([
      { name: "serial", value: str("5") },
      { name: "editionKey", value: optional(str("1:base:1")) },
      { name: "owner", value: str("0xabc") },
    ])
    expect(extractEditionKey(raw)).toBe("1:base:1")
  })

  it("returns null for an EMPTY Optional (nil on chain)", () => {
    const raw = structWith([{ name: "editionKey", value: optional(null) }])
    expect(extractEditionKey(raw)).toBeNull()
  })
  it("returns null for an empty-string value (never a partial key)", () => {
    expect(extractEditionKey(structWith([{ name: "editionKey", value: optional(str("")) }]))).toBeNull()
    expect(extractEditionKey(structWith([{ name: "editionKey", value: str("") }]))).toBeNull()
  })
  it("returns null when the field is absent", () => {
    expect(extractEditionKey(structWith([{ name: "serial", value: str("1") }]))).toBeNull()
  })
  it("returns null for a malformed / non-struct envelope, never throws", () => {
    expect(extractEditionKey(null)).toBeNull()
    expect(extractEditionKey(undefined)).toBeNull()
    expect(extractEditionKey("nope")).toBeNull()
    expect(extractEditionKey({})).toBeNull()
    expect(extractEditionKey({ type: "Struct", value: { fields: "bad" } })).toBeNull()
    expect(extractEditionKey(structWith([{ name: "editionKey", value: null }]))).toBeNull()
  })
})

describe("edge-fn source-drift guard — pinnacle-nft-resolver inline copy", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/pinnacle-nft-resolver/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/pinnacle-edition-key/.test(edgeSrc)
  // Canonical inline expression — the Optional descent that is the whole point.
  const OPTIONAL_DESCENT = norm('if (outer.type === "Optional") {')
  const FIELD_MATCH = norm('if (f.name !== "editionKey") continue')

  it.each([
    ["Optional descent", OPTIONAL_DESCENT],
    ["editionKey field match", FIELD_MATCH],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
