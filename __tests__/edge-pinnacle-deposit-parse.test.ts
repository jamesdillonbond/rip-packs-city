import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { extractPinnacleDeposit } from "@/supabase/functions/_shared/pinnacle-deposit-parse"

// Pins the Pinnacle ownership-decode logic (extractDeposit) shared by
// pinnacle-owner-discovery, -forward, and ingest-pinnacle-mints. This decides
// who owns a Pinnacle NFT, so a regression mis-attributes or drops ownership.

// Build a base64 JSON-CDC Deposit event { id, to } the way Flow REST returns it.
function depositEvent(id: string | null, to: string | null): string {
  const fields: Array<{ name: string; value: unknown }> = []
  if (id !== null) fields.push({ name: "id", value: { type: "UInt64", value: id } })
  if (to !== null) fields.push({ name: "to", value: { type: "Optional", value: { type: "Address", value: to } } })
  const payload = { type: "Event", value: { id: "A.x.Deposit", fields } }
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
}

describe("extractPinnacleDeposit", () => {
  it("decodes a valid Deposit to { nftId, to } and lowercases the address", () => {
    expect(extractPinnacleDeposit(depositEvent("12345", "0xABCDEF0123456789"))).toEqual({
      nftId: "12345",
      to: "0xabcdef0123456789",
    })
  })

  it("returns null when id is missing", () => {
    expect(extractPinnacleDeposit(depositEvent(null, "0xabc"))).toBeNull()
  })

  it("returns null when to is missing (empty Optional)", () => {
    // to present but its Optional is null → after unwrap, to is null
    const payload = {
      type: "Event",
      value: {
        fields: [
          { name: "id", value: { type: "UInt64", value: "7" } },
          { name: "to", value: { type: "Optional", value: null } },
        ],
      },
    }
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
    expect(extractPinnacleDeposit(b64)).toBeNull()
  })

  it("returns null when to is not a 0x address (the ownership gate)", () => {
    expect(extractPinnacleDeposit(depositEvent("7", "flow-alias"))).toBeNull()
  })

  it("returns null (never throws) on malformed base64 / JSON", () => {
    expect(extractPinnacleDeposit("@@@not base64@@@")).toBeNull()
    expect(extractPinnacleDeposit(Buffer.from("not json", "utf8").toString("base64"))).toBeNull()
  })
})

describe("source-drift guard — the 3 inline extractDeposit copies keep the ownership invariants", () => {
  // The three copies differ only in local var names + log prefixes, so a byte
  // guard would false-alarm. Instead pin the LOAD-BEARING invariants that decide
  // ownership: it must unwrapCdc the payload, lowercase the address, and gate on
  // a 0x prefix. Dropping any of those (the real regressions) fails here.
  const root = process.cwd()
  const FILES = [
    "pinnacle-owner-discovery",
    "pinnacle-owner-discovery-forward",
    "ingest-pinnacle-mints",
  ]

  // The return type `{ nftId: string; to: string } | null` contains braces, so a
  // brace-matcher started at the first `{` grabs the type, not the body. For a
  // token-presence guard we don't need the exact body — slice a generous window
  // from the signature to the next top-level `function ` (or the file end).
  function extractFnWindow(src: string, name: string): string | null {
    const sig = src.indexOf(`function ${name}(`)
    if (sig < 0) return null
    const after = src.indexOf("\nfunction ", sig + 1)
    return src.slice(sig, after < 0 ? Math.min(src.length, sig + 1500) : after)
  }

  for (const fn of FILES) {
    const src = readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8")
    const importsShared = /from\s+["'][^"']*_shared\/pinnacle-deposit-parse/.test(src)
    const body = extractFnWindow(src, "extractDeposit")

    it(`${fn}: extractDeposit exists (inline) or is imported from _shared`, () => {
      expect(importsShared || body !== null).toBe(true)
    })

    it(`${fn}: inline extractDeposit keeps unwrapCdc + lowercasing + the 0x gate`, () => {
      if (importsShared || body === null) return // imported → invariants live in _shared (tested above)
      expect(body).toContain("unwrapCdc")
      expect(body).toContain(".toLowerCase()")
      expect(body).toContain('.startsWith("0x")')
    })
  }
})

describe("unwrapCdc parity — the Pinnacle group's inline copy matches _shared/cdc", () => {
  // The Pinnacle group carries the FULL unwrapCdc (Struct/Event field-flattening),
  // which extractDeposit needs to reach a Deposit event's fields. Pin that it
  // stays equal to the tested _shared/cdc.ts copy (semicolon/whitespace-insensitive).
  // NOTE: sales-serial-backfill / backfill-allday-listing-serials / scan-ufc-wallet
  // carry a DIFFERENT, reduced unwrapCdc (no composite branches) — deliberately
  // NOT guarded here; see the ledger finding.
  const root = process.cwd()
  const norm = (s: string) =>
    s.replace(/^export\s+/, "").replace(/;/g, "").replace(/\s+/g, " ").trim()
  function extractFn(src: string, name: string): string | null {
    const sig = src.search(new RegExp(`(export\\s+)?function ${name}\\(`))
    if (sig < 0) return null
    const open = src.indexOf("{", sig)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") {
        depth--
        if (depth === 0) return norm(src.slice(sig, i + 1))
      }
    }
    return null
  }
  const shared = extractFn(
    readFileSync(path.join(root, "supabase/functions/_shared/cdc.ts"), "utf8"),
    "unwrapCdc",
  )

  it.each(["pinnacle-owner-discovery", "pinnacle-owner-discovery-forward", "ingest-pinnacle-mints"])(
    "%s inline unwrapCdc == _shared/cdc unwrapCdc",
    (fn) => {
      const inline = extractFn(
        readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8"),
        "unwrapCdc",
      )
      expect(inline).not.toBeNull()
      expect(inline).toBe(shared)
    },
  )
})
