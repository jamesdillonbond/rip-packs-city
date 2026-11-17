import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { extractMint, extractDeposit } from "@/supabase/functions/_shared/pinnacle-mint-parse"

// Pins the Disney Pinnacle mint/deposit CDC decoders (see the module header).
// Every Pinnacle NFT enters the catalog through extractMint and gets its owner
// through extractDeposit; a wrong field pull or a swallowed guard silently drops
// a mint or mis-attributes an owner, invisible until the surface goes stale.

// ── JSON-CDC node builders (mirror __tests__/edge-cdc.test.ts) ──────────────────
const optional = (node: unknown) => ({ type: "Optional", value: node })
const uint64 = (n: number | string) => ({ type: "UInt64", value: String(n) })
const uint32 = (n: number | string) => ({ type: "UInt32", value: String(n) })
const str = (s: string) => ({ type: "String", value: s })
const addr = (a: string) => ({ type: "Address", value: a })
const event = (fields: Array<[string, unknown]>) => ({
  type: "Event",
  value: { id: "A.pinnacle.Event", fields: fields.map(([name, value]) => ({ name, value })) },
})

// The decoders receive base64(JSON.stringify(cdcNode)).
const encode = (node: unknown) => btoa(JSON.stringify(node))

describe("extractMint — pulls id/renderID/editionID off a Pinnacle mint event", () => {
  it("decodes a full mint (id + render + edition)", () => {
    const payload = encode(event([
      ["id", uint64(42)],
      ["renderID", str("render-abc")],
      ["editionID", uint32(7)],
    ]))
    expect(extractMint(payload)).toEqual({ nftId: "42", renderId: "render-abc", editionId: 7 })
  })

  it("returns null when the nft id is absent (no mint without an id)", () => {
    const payload = encode(event([["renderID", str("r")], ["editionID", uint32(1)]]))
    expect(extractMint(payload)).toBeNull()
  })

  it("returns null when id is an Optional(null)", () => {
    const payload = encode(event([["id", optional(null)], ["renderID", str("r")]]))
    expect(extractMint(payload)).toBeNull()
  })

  it("renderId is null when renderID is missing / Optional(null)", () => {
    const missing = encode(event([["id", uint64(9)], ["editionID", uint32(3)]]))
    expect(extractMint(missing)).toEqual({ nftId: "9", renderId: null, editionId: 3 })
    const nulled = encode(event([["id", uint64(9)], ["renderID", optional(null)], ["editionID", uint32(3)]]))
    expect(extractMint(nulled)?.renderId).toBeNull()
  })

  it("editionId is null when editionID is missing", () => {
    const payload = encode(event([["id", uint64(9)], ["renderID", str("r")]]))
    expect(extractMint(payload)).toEqual({ nftId: "9", renderId: "r", editionId: null })
  })

  it("editionId is null when editionID is non-numeric (Number.isFinite guard)", () => {
    const payload = encode(event([["id", uint64(9)], ["editionID", str("not-a-number")]]))
    expect(extractMint(payload)?.editionId).toBeNull()
  })

  it("coerces a numeric-string render id to string, edition to number", () => {
    const payload = encode(event([["id", uint64(1)], ["renderID", uint64(555)], ["editionID", uint32(12)]]))
    const out = extractMint(payload)
    expect(out?.renderId).toBe("555")
    expect(out?.editionId).toBe(12)
  })

  it("returns null on a malformed base64 payload (decode error is swallowed)", () => {
    expect(extractMint("@@not-base64@@")).toBeNull()
    expect(extractMint(btoa("{not json"))).toBeNull()
  })
})

describe("extractDeposit — pulls id + owner off a deposit event", () => {
  it("decodes a deposit and lowercases the destination address", () => {
    const payload = encode(event([["id", uint64(42)], ["to", addr("0xABCDEF0123456789")]]))
    expect(extractDeposit(payload)).toEqual({ nftId: "42", to: "0xabcdef0123456789" })
  })

  it("returns null when id or to is absent", () => {
    expect(extractDeposit(encode(event([["to", addr("0xabc")]])))).toBeNull()
    expect(extractDeposit(encode(event([["id", uint64(1)]])))).toBeNull()
  })

  it("returns null when `to` is Optional(null)", () => {
    expect(extractDeposit(encode(event([["id", uint64(1)], ["to", optional(null)]])))).toBeNull()
  })

  it("rejects a destination that is not a 0x address", () => {
    const payload = encode(event([["id", uint64(1)], ["to", str("flow-name.find")]]))
    expect(extractDeposit(payload)).toBeNull()
  })

  it("returns null on a malformed base64 payload", () => {
    expect(extractDeposit("%%%")).toBeNull()
  })
})

// ── source-drift guard ──────────────────────────────────────────────────────
// The deployed edge fn (ingest-pinnacle-mints/index.ts) carries inline copies of
// extractMint / extractDeposit. Rewiring it to import from _shared is a
// deploy-gated follow-up; until then this guard enforces "keep in sync"
// mechanically — either the edge fn imports from _shared (drift impossible) or
// its inline body is byte-identical (whitespace-normalized) to the _shared body.
describe("edge-fn source-drift guard — the inline Pinnacle decoders cannot silently diverge", () => {
  const root = process.cwd()
  const edgeSrc = readFileSync(
    path.join(root, "supabase/functions/ingest-pinnacle-mints/index.ts"),
    "utf8",
  )
  const sharedSrc = readFileSync(
    path.join(root, "supabase/functions/_shared/pinnacle-mint-parse.ts"),
    "utf8",
  )

  /** Extract a top-level `function NAME(...) {...}` body via brace matching. */
  function extractFn(src: string, name: string): string | null {
    const sig = src.indexOf(`function ${name}(`)
    if (sig < 0) return null
    const open = src.indexOf("{", sig)
    if (open < 0) return null
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") {
        depth--
        if (depth === 0) return src.slice(sig, i + 1).replace(/\s+/g, " ").trim()
      }
    }
    return null
  }

  const importsFromShared = /from\s+["'][^"']*_shared\/pinnacle-mint-parse/.test(edgeSrc)

  it.each(["extractMint", "extractDeposit"])(
    "%s: edge fn imports it from _shared, or its inline body matches _shared byte-for-byte",
    (name) => {
      const edgeBody = extractFn(edgeSrc, name)
      const sharedBody = extractFn(sharedSrc, name)
      expect(sharedBody, `_shared must define ${name}`).not.toBeNull()

      if (edgeBody === null) {
        expect(importsFromShared, `${name} is absent inline but the edge fn does not import _shared`).toBe(true)
        return
      }
      expect(edgeBody).toBe(sharedBody)
    },
  )
})
