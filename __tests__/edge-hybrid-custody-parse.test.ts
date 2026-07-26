import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  unwrap,
  parseAccountUpdatedPayload,
  type CdcNode,
} from "@/supabase/functions/_shared/hybrid-custody-parse"

// Unit tests for the HybridCustody AccountUpdated event parser, extracted from
// hybrid-custody-events/index.ts. This tuple (child, parent, active) is what
// establishes/clears a parent↔child wallet link used to dedup leaderboards, so
// the parser must REJECT a malformed payload (return null) rather than write a
// half-link, and must never throw on a bad id.

// ── JSON-CDC node builders ────────────────────────────────────────────────────
const optional = (node: unknown) => ({ type: "Optional", value: node })
const uint64 = (n: number | string) => ({ type: "UInt64", value: String(n) })
const addr = (a: string) => ({ type: "Address", value: a })
const bool = (b: boolean) => ({ type: "Bool", value: b })

function b64(node: unknown): string {
  return Buffer.from(JSON.stringify(node), "utf8").toString("base64")
}

// AccountUpdated event payload: { type:"Event", value:{ id, fields:[{name,value}] } }
function accountUpdated(fields: Array<[string, unknown]>): string {
  return b64({
    type: "Event",
    value: {
      id: "A.d8a7e05a7ac670c0.HybridCustody.AccountUpdated",
      fields: fields.map(([name, value]) => ({ name, value })),
    },
  })
}

const CHILD = "0xd8a7e05a7ac670c0"
const PARENT = "0xbd94cade097e50ac"

describe("unwrap — typed / Optional node → primitive", () => {
  it("returns the inner value of a filled Optional", () => {
    expect(unwrap(optional(addr(CHILD)) as CdcNode)).toBe(CHILD)
  })
  it("returns null for Optional(null) and for a nullish node", () => {
    expect(unwrap(optional(null) as CdcNode)).toBeNull()
    expect(unwrap(null)).toBeNull()
    expect(unwrap(undefined)).toBeNull()
  })
  it("returns the raw value of a plain typed scalar", () => {
    expect(unwrap(bool(true) as CdcNode)).toBe(true)
    expect(unwrap(uint64("77") as CdcNode)).toBe("77")
  })
})

describe("parseAccountUpdatedPayload — happy path", () => {
  it("parses a full active-link payload with keyed (not positional) field lookup", () => {
    // Deliberately shuffle field order to prove name-keying.
    const payload = accountUpdated([
      ["active", bool(true)],
      ["parent", addr(PARENT)],
      ["id", optional(uint64("42"))],
      ["child", addr(CHILD)],
    ])
    expect(parseAccountUpdatedPayload(payload)).toEqual({
      id: BigInt(42),
      child: CHILD,
      parent: PARENT,
      active: true,
    })
  })

  it("parses an inactive (link-cleared) payload", () => {
    const payload = accountUpdated([
      ["id", uint64("7")],
      ["child", addr(CHILD)],
      ["parent", addr(PARENT)],
      ["active", bool(false)],
    ])
    expect(parseAccountUpdatedPayload(payload)).toEqual({
      id: BigInt(7),
      child: CHILD,
      parent: PARENT,
      active: false,
    })
  })

  it("yields id=null (never throws) when the id is an empty Optional", () => {
    const payload = accountUpdated([
      ["id", optional(null)],
      ["child", addr(CHILD)],
      ["parent", addr(PARENT)],
      ["active", bool(true)],
    ])
    expect(parseAccountUpdatedPayload(payload)).toEqual({
      id: null,
      child: CHILD,
      parent: PARENT,
      active: true,
    })
  })

  it("yields id=null when the id string is unparseable as BigInt (degrades, no throw)", () => {
    const payload = accountUpdated([
      ["id", { type: "String", value: "not-a-number" }],
      ["child", addr(CHILD)],
      ["parent", addr(PARENT)],
      ["active", bool(true)],
    ])
    const r = parseAccountUpdatedPayload(payload)
    expect(r).not.toBeNull()
    expect(r!.id).toBeNull()
    expect(r!.active).toBe(true)
  })
})

describe("parseAccountUpdatedPayload — rejects malformed payloads (null, not a half-link)", () => {
  it("returns null when child is missing / not a string", () => {
    const payload = accountUpdated([
      ["parent", addr(PARENT)],
      ["active", bool(true)],
    ])
    expect(parseAccountUpdatedPayload(payload)).toBeNull()
  })

  it("returns null when parent is missing", () => {
    const payload = accountUpdated([
      ["child", addr(CHILD)],
      ["active", bool(true)],
    ])
    expect(parseAccountUpdatedPayload(payload)).toBeNull()
  })

  it("returns null when active is absent or not a boolean", () => {
    const missing = accountUpdated([
      ["child", addr(CHILD)],
      ["parent", addr(PARENT)],
    ])
    expect(parseAccountUpdatedPayload(missing)).toBeNull()
    const wrongType = accountUpdated([
      ["child", addr(CHILD)],
      ["parent", addr(PARENT)],
      ["active", { type: "String", value: "true" }],
    ])
    expect(parseAccountUpdatedPayload(wrongType)).toBeNull()
  })

  it("returns null when the payload has no fields array", () => {
    expect(parseAccountUpdatedPayload(b64({ type: "Event", value: {} }))).toBeNull()
  })

  it("returns null on non-base64 / non-JSON garbage instead of throwing", () => {
    expect(parseAccountUpdatedPayload("@@@not base64@@@")).toBeNull()
    expect(parseAccountUpdatedPayload(Buffer.from("not json", "utf8").toString("base64"))).toBeNull()
  })
})

describe("edge-fn source-drift guard — hybrid-custody inline copies vs _shared", () => {
  // hybrid-custody-events/index.ts AND hybrid-custody-backfill/index.ts carry
  // inline copies of decodeBase64Json / unwrap / parseAccountUpdatedPayload that
  // _shared/hybrid-custody-parse.ts also exports (tested above). Neither edge fn
  // imports from _shared today, so the inline copies could silently diverge from
  // the tested version — writing a half-link or throwing on a bad id. This guard
  // enforces "keep in sync": for each function, EITHER the edge fn imports it
  // from _shared (drift impossible), OR its inline body is byte-identical
  // (whitespace-normalized) to the _shared body. Same mechanism as the pack-ev
  // edge-fn drift guard.
  const root = process.cwd()
  const sharedSrc = readFileSync(
    path.join(root, "supabase/functions/_shared/hybrid-custody-parse.ts"),
    "utf8",
  )

  // Normalize away purely-stylistic differences (semicolons, the `export`
  // keyword) so the guard compares the FUNCTIONAL body — the _shared copy is
  // semicolon-free / exported, the Deno edge copies use semicolons. A real logic
  // change (renamed field, flipped guard, changed recursion) still diverges.
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
        if (depth === 0) {
          return src
            .slice(sig, i + 1)
            .replace(/;/g, "")
            .replace(/\s+/g, " ")
            .trim()
        }
      }
    }
    return null
  }

  const EDGE_FNS = ["hybrid-custody-events", "hybrid-custody-backfill"] as const
  // hybrid-custody-events carries all three; backfill only decodeBase64Json/unwrap
  // are shared shapes (its decodeStructResult is bespoke). Guard whichever names
  // each file actually defines inline.
  for (const fn of EDGE_FNS) {
    const edgeSrc = readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8")
    const importsShared = /from\s+["'][^"']*_shared\/hybrid-custody-parse/.test(edgeSrc)
    for (const name of ["decodeBase64Json", "unwrap", "parseAccountUpdatedPayload"]) {
      const edgeBody = extractFn(edgeSrc, name)
      if (edgeBody === null) continue // this file doesn't define it inline — nothing to drift
      const sharedBody = extractFn(sharedSrc, name)
      it(`${fn}: inline ${name} matches _shared byte-for-byte (or is imported)`, () => {
        expect(sharedBody, `_shared must define ${name}`).not.toBeNull()
        expect(importsShared || edgeBody === sharedBody).toBe(true)
      })
    }
  }
})
