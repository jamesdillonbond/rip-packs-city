import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  b64Utf8,
  b64ToUtf8,
  flattenCadenceDict,
  pickPlayerName,
  parseResolvedMeta,
} from "@/supabase/functions/_shared/topshot-stub-parse"

// Pins topshot-stub-resolver's parse/decode core — the logic that decides what
// player/set/team name lands in `editions`. The mojibake trap here is the same
// class that corrupted 55 pack titles + 308 metadata rows on a sibling path.

describe("b64Utf8 / b64ToUtf8 — UTF-8-safe base64 round-trip (the mojibake guard)", () => {
  it("round-trips ASCII unchanged", () => {
    expect(b64ToUtf8(b64Utf8("Base Set"))).toBe("Base Set")
  })
  it("round-trips non-ASCII player names WITHOUT double-encoding", () => {
    for (const name of ["Dončić", "Jokić", "Şengün", "Nikola Jokić"]) {
      expect(b64ToUtf8(b64Utf8(name))).toBe(name)
    }
  })
  it("b64ToUtf8 differs from a latin1 atob on multi-byte input (proves the fix matters)", () => {
    const encoded = b64Utf8("Dončić")
    // atob (latin1) would mojibake; b64ToUtf8 must NOT equal it.
    expect(b64ToUtf8(encoded)).toBe("Dončić")
    expect(atob(encoded)).not.toBe("Dončić")
  })
})

describe("flattenCadenceDict — Flow REST {String:String} → JS dict", () => {
  it("flattens key/value string pairs", () => {
    const parsed = {
      value: [
        { key: { value: "FullName" }, value: { value: "LeBron James" } },
        { key: { value: "__SetName" }, value: { value: "Base Set" } },
      ],
    }
    expect(flattenCadenceDict(parsed)).toEqual({ FullName: "LeBron James", __SetName: "Base Set" })
  })
  it("skips non-string entries, never throws", () => {
    const parsed = {
      value: [
        { key: { value: "A" }, value: { value: "x" } },
        { key: { value: "B" }, value: { value: 5 } }, // non-string value → skipped
        { key: { value: 7 }, value: { value: "y" } }, // non-string key → skipped
      ],
    }
    expect(flattenCadenceDict(parsed)).toEqual({ A: "x" })
  })
  it("a non-array / malformed payload → empty dict", () => {
    expect(flattenCadenceDict(null)).toEqual({})
    expect(flattenCadenceDict({})).toEqual({})
    expect(flattenCadenceDict({ value: "nope" })).toEqual({})
  })
})

describe("pickPlayerName — FullName with FirstName/LastName fallback", () => {
  it("prefers a trimmed FullName", () => {
    expect(pickPlayerName({ FullName: "  Kevin Durant  " })).toBe("Kevin Durant")
  })
  it("falls back to First + Last when FullName is the literal <invalid Value>", () => {
    expect(pickPlayerName({ FullName: "<invalid Value>", FirstName: "Ja", LastName: "Morant" })).toBe(
      "Ja Morant",
    )
  })
  it("falls back when FullName is empty/whitespace", () => {
    expect(pickPlayerName({ FullName: "   ", FirstName: "Luka", LastName: "Dončić" })).toBe(
      "Luka Dončić",
    )
  })
  it("composes with only one of first/last present", () => {
    expect(pickPlayerName({ FirstName: "Giannis" })).toBe("Giannis")
    expect(pickPlayerName({ LastName: "Embiid" })).toBe("Embiid")
  })
  it("returns null when nothing usable exists (team-moment play)", () => {
    expect(pickPlayerName({})).toBeNull()
    expect(pickPlayerName({ FullName: "<invalid Value>" })).toBeNull()
  })
})

describe("parseResolvedMeta — coercion into the editions write payload", () => {
  it("shapes a full meta dict", () => {
    const r = parseResolvedMeta({
      FullName: "Anthony Edwards",
      __SetName: "  Rookie Debut  ",
      __SetSeries: "5",
      __Circulation: "749",
      TeamAtMoment: "  Minnesota Timberwolves  ",
    })
    expect(r).toEqual({
      playerName: "Anthony Edwards",
      setName: "Rookie Debut",
      circulation: 749,
      team: "Minnesota Timberwolves",
      series: 5,
    })
  })
  it("series/circulation are null (never NaN) when non-numeric on chain", () => {
    const r = parseResolvedMeta({ FullName: "X", __SetSeries: "n/a", __Circulation: "n/a" })
    expect(r.series).toBeNull()
    expect(r.circulation).toBeNull()
  })
  it("verbatim edge behavior: an empty-string numeric coerces to 0, not null (Number('')===0)", () => {
    // Documents the real inline behavior so a future 'fix' to null is a conscious
    // change, not an accident. __Circulation is only set when on-chain returns it.
    expect(parseResolvedMeta({ FullName: "X", __Circulation: "" }).circulation).toBe(0)
  })
  it("series 0 is kept (a real on-chain value, Series 1)", () => {
    expect(parseResolvedMeta({ FullName: "X", __SetSeries: "0" }).series).toBe(0)
  })
  it("empty setName/team trim to null", () => {
    const r = parseResolvedMeta({ FullName: "X", __SetName: "   ", TeamAtMoment: "" })
    expect(r.setName).toBeNull()
    expect(r.team).toBeNull()
  })
})

describe("edge-fn source-drift guard — topshot-stub-resolver inline copies", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/topshot-stub-resolver/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/topshot-stub-parse/.test(edgeSrc)

  // Canonical inline expressions (whitespace-normalized) — an un-mirrored edit
  // reddens CI. Import-or-inline pattern like the other edge-fn guards.
  const DECODE = norm("new TextDecoder(\"utf-8\").decode(bytes)")
  const INVALID_GUARD = norm('full && full !== "<invalid Value>" && full.trim() !== ""')
  const SERIES_COERCE = norm("Number.isFinite(Number(seriesRaw)) ? Number(seriesRaw) : null")

  it.each([
    ["utf-8 decode", DECODE],
    ["<invalid Value> guard", INVALID_GUARD],
    ["series numeric coercion", SERIES_COERCE],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
