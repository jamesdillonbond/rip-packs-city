import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { toFlowAddr } from "@/supabase/functions/_shared/flow-address"

// Pins toFlowAddr — the ownership-gating Flow-address normalizer duplicated
// (identically) in special-serial-sweep + special-serial-delta. A value that
// slips through becomes an owner key; one wrongly rejected drops a special
// serial's owner.

describe("toFlowAddr", () => {
  it("passes a canonical 0x + 16-hex address through, lowercased", () => {
    expect(toFlowAddr("0xABCDEF0123456789")).toBe("0xabcdef0123456789")
  })
  it("adds a missing 0x prefix to a bare 16-hex id", () => {
    expect(toFlowAddr("abcdef0123456789")).toBe("0xabcdef0123456789")
  })
  it("trims surrounding whitespace", () => {
    expect(toFlowAddr("  0xabcdef0123456789  ")).toBe("0xabcdef0123456789")
  })
  it("rejects the wrong length (Flow addresses are exactly 8 bytes / 16 hex)", () => {
    expect(toFlowAddr("0xabc")).toBeNull() // too short
    expect(toFlowAddr("0xabcdef01234567890")).toBeNull() // 17 hex, too long
  })
  it("rejects non-hex characters", () => {
    expect(toFlowAddr("0xghijklmnopqrstuv")).toBeNull()
  })
  it("returns null (never throws) for empty / nullish / non-string input", () => {
    expect(toFlowAddr("")).toBeNull()
    expect(toFlowAddr("   ")).toBeNull()
    expect(toFlowAddr(null)).toBeNull()
    expect(toFlowAddr(undefined)).toBeNull()
    expect(toFlowAddr(12345)).toBeNull() // 5 digits, not 16
  })
})

describe("source-drift guard — special-serial fns' inline toFlowAddr matches _shared", () => {
  const root = process.cwd()
  const norm = (s: string) =>
    s.replace(/\/\/[^\n]*/g, "").replace(/^\s*export\s+/, "").replace(/;/g, "").replace(/\s+/g, " ").trim()
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
    readFileSync(path.join(root, "supabase/functions/_shared/flow-address.ts"), "utf8"),
    "toFlowAddr",
  )
  it.each(["special-serial-sweep", "special-serial-delta"])(
    "%s inline toFlowAddr == _shared (or imports it)",
    (fn) => {
      const src = readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8")
      const importsShared = /from\s+["'][^"']*_shared\/flow-address/.test(src)
      const inline = extractFn(src, "toFlowAddr")
      expect(importsShared || inline === shared).toBe(true)
    },
  )
})
