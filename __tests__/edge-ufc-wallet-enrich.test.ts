import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  b64ToUtf8,
  inferTier,
  makeEditionKey,
  parseResult,
  titleCase,
} from "@/supabase/functions/_shared/ufc-wallet-enrich"

// Pins enrich-ufc-wallet's parse/decode core — the logic that decides WHAT NAME
// and WHAT TIER land on a collector's UFC Strike moment. Two layers: unit tests
// on the extracted pure logic, and a source-drift guard so the deployed edge
// fn's inline copies can't silently diverge from what these tests pin. Edge fns
// are outside the vitest coverage measure, so without this the money/name path
// had NO automated cover.

const enc = (s: string) => Buffer.from(s, "utf8").toString("base64")

describe("b64ToUtf8 — mojibake-safe base64 decode", () => {
  it("decodes a multi-byte UTF-8 name correctly (no latin1 double-encode)", () => {
    // "José Aldo" round-trips; a plain atob would yield "JosÃ© Aldo".
    expect(b64ToUtf8(enc("José Aldo"))).toBe("José Aldo")
    expect(b64ToUtf8(enc("Michał Oleksiejczuk"))).toBe("Michał Oleksiejczuk")
  })
  it("is a no-op for pure ASCII", () => {
    expect(b64ToUtf8(enc("Jon Jones"))).toBe("Jon Jones")
  })
  it("decodes the empty string to empty", () => {
    expect(b64ToUtf8(enc(""))).toBe("")
  })
})

describe("inferTier — max-circulation banded UFC tier", () => {
  it.each([
    [null, "FANDOM"],
    [0, "FANDOM"],
    [1, "ULTIMATE"],
    [10, "ULTIMATE"],
    [11, "CHAMPION"],
    [99, "CHAMPION"],
    [100, "CHALLENGER"],
    [999, "CHALLENGER"],
    [1000, "CONTENDER"],
    [25000, "CONTENDER"],
    [25001, "FANDOM"],
  ])("max=%s → %s", (max, tier) => {
    expect(inferTier(max as number | null)).toBe(tier)
  })
  it("puts the band boundaries on the exact edges (a slip mis-scores scarcity)", () => {
    expect(inferTier(10)).toBe("ULTIMATE")
    expect(inferTier(11)).not.toBe("ULTIMATE")
  })
})

describe("makeEditionKey", () => {
  it("collapses non-alnum runs to single dashes and appends max", () => {
    expect(makeEditionKey("Jon 'Bones' Jones", 500)).toBe("Jon-Bones-Jones-500")
  })
  it("trims leading/trailing dashes and defaults a null max to 0", () => {
    expect(makeEditionKey("!Champion!", null)).toBe("Champion-0")
  })
})

describe("parseResult — Cadence {String:String} → dict", () => {
  it("flattens the value array into a plain object", () => {
    const raw = {
      value: [
        { key: { value: "name" }, value: { value: "Jon Jones" } },
        { key: { value: "max" }, value: { value: "500" } },
      ],
    }
    expect(parseResult(raw)).toEqual({ name: "Jon Jones", max: "500" })
  })
  it("returns {} when there is no value array", () => {
    expect(parseResult({})).toEqual({})
    expect(parseResult(null)).toEqual({})
  })
})

describe("titleCase", () => {
  it("capitalizes each word and lowercases the rest", () => {
    expect(titleCase("JON JONES")).toBe("Jon Jones")
    expect(titleCase("light heavyweight")).toBe("Light Heavyweight")
  })
})

describe("edge-fn source-drift guard — enrich-ufc-wallet inline copies", () => {
  // The edge fn carries these primitives inline. It is outside the coverage
  // measure and not necessarily redeployed on every change, so this guard
  // enforces "keep in sync" mechanically: the edge fn must EITHER import from
  // _shared/ufc-wallet-enrich (drift impossible) OR still carry each canonical
  // expression verbatim (whitespace-normalized). An un-mirrored edit reddens CI.
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(readFileSync(path.join(root, "supabase/functions/enrich-ufc-wallet/index.ts"), "utf8"))
  const importsShared = /from\s+["'][^"']*_shared\/ufc-wallet-enrich/.test(edgeSrc)

  const DECODE = norm('new TextDecoder("utf-8").decode(bytes)')
  const TIER_ULTIMATE = norm('if (max <= 10) return "ULTIMATE";')
  const TIER_CONTENDER = norm('if (max <= 25000) return "CONTENDER";')
  const EDITION_KEY = norm('name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + (max ?? 0)')

  it.each([
    ["utf-8 decode", DECODE],
    ["ULTIMATE band", TIER_ULTIMATE],
    ["CONTENDER band", TIER_CONTENDER],
    ["edition-key slug", EDITION_KEY],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
