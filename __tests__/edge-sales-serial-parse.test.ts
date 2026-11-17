import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { normalizeAddr, parsePositiveSerial } from "@/supabase/functions/_shared/sales-serial-parse"

// Pins sales-serial-backfill's two write-gates — the strict Flow-address
// normalizer (attribution) and the positive-serial rule (which serial, if any,
// lands in sales.serial_number and thus into the serial-FMV multiplier). Edge
// fns are outside the vitest coverage measure, so without this the serial money
// path had NO automated cover. Two layers: unit tests + a source-drift guard.

describe("normalizeAddr — strict, prefix-REQUIRED Flow address", () => {
  it("accepts a canonical 0x + 16-hex address (lowercased, trimmed)", () => {
    expect(normalizeAddr("  0xABCDEF0123456789  ")).toBe("0xabcdef0123456789")
  })
  it("REJECTS a bare 16-hex string (unlike toFlowAddr, this variant adds no prefix)", () => {
    expect(normalizeAddr("abcdef0123456789")).toBeNull()
  })
  it("rejects wrong-length hex and non-hex", () => {
    expect(normalizeAddr("0xabc")).toBeNull()
    expect(normalizeAddr("0xabcdef012345678")).toBeNull() // 15 digits
    expect(normalizeAddr("0xabcdef01234567890")).toBeNull() // 17 digits
    expect(normalizeAddr("0xghijkl0123456789")).toBeNull()
  })
  it("rejects null/undefined/empty without throwing", () => {
    expect(normalizeAddr(null)).toBeNull()
    expect(normalizeAddr(undefined)).toBeNull()
    expect(normalizeAddr("")).toBeNull()
  })
})

describe("parsePositiveSerial — positive-finite gate on serial writes", () => {
  it("accepts a positive integer (numeric or numeric string)", () => {
    expect(parsePositiveSerial(1)).toBe(1)
    expect(parsePositiveSerial("42")).toBe(42)
  })
  it("rejects 0 and negatives (never overwrites with a non-serial)", () => {
    expect(parsePositiveSerial(0)).toBeNull()
    expect(parsePositiveSerial("0")).toBeNull()
    expect(parsePositiveSerial(-5)).toBeNull()
  })
  it("rejects null/undefined/NaN/non-numeric", () => {
    expect(parsePositiveSerial(null)).toBeNull()
    expect(parsePositiveSerial(undefined)).toBeNull()
    expect(parsePositiveSerial("not-a-number")).toBeNull()
    expect(parsePositiveSerial(Number.NaN)).toBeNull()
  })
  it("accepts serial #1 (the highest-multiplier serial — must not be dropped)", () => {
    expect(parsePositiveSerial("1")).toBe(1)
  })
})

describe("edge-fn source-drift guard — sales-serial-backfill inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/sales-serial-backfill/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/sales-serial-parse/.test(edgeSrc)

  const ADDR_REGEX = norm('/^0x[0-9a-f]{16}$/.test(s)')
  const SERIAL_RULE = norm("if (!Number.isFinite(n) || n <= 0)")

  it.each([
    ["strict address regex", ADDR_REGEX],
    ["positive-serial rule", SERIAL_RULE],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
