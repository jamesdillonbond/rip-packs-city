import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isSupportedFontBuffer } from "@/lib/og/font-bytes"

// The bytes-are-a-font check, and the two loaders that must apply it.
//
// ── THE FAILURE THIS PREVENTS ───────────────────────────────────────────────
// `app/api/og/profile/[username]` and `app/api/profile/trophy-case/pdf` fetch the
// vendored brand fonts over HTTP at render time. Both validated the RESPONSE
// (`res.ok`, non-zero length) and neither validated the BYTES, so any 200 whose
// body is not a font — an HTML error page, a redirect landing on markup, the SSO
// interstitial this project's preview URLs are documented to serve — sailed
// through and satori threw `Unsupported OpenType signature <!DO`, the first four
// bytes of `<!DOCTYPE`. That reddened CI on 2026-08-13 the moment a fetch stub
// returned JSON for every URL, which is exactly what a misrouted font URL does.
//
// ⚠ The OG route already had a three-tier try/catch written for precisely this
// hazard ("a font satori rejects THROWS rather than degrading") and it could not
// help: `new ImageResponse(...)` returns a Response whose body is a STREAM, so
// satori runs when the body is consumed — after GET has returned. The throw
// escapes the handler. A guard around the constructor can never see it, which is
// why the check has to be on the bytes, before the renderer.

const FONTS = join(process.cwd(), "public", "fonts")

/** ASCII → the 4-byte big-endian word a signature check reads. */
function sig(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)))
}

describe("isSupportedFontBuffer", () => {
  it("accepts the two REAL vendored brand fonts", () => {
    // The positive anchor. Without it, `() => false` would satisfy every
    // rejection case below while disabling branding everywhere.
    for (const f of ["BarlowCondensed-Black.ttf", "ShareTechMono-Regular.ttf"]) {
      expect(isSupportedFontBuffer(readFileSync(join(FONTS, f))), f).toBe(true)
    }
  })

  it("rejects an HTML document — the exact production shape", () => {
    expect(isSupportedFontBuffer(Buffer.from("<!DOCTYPE html><html>…"))).toBe(false)
  })

  it.each([
    ["JSON", "{\"error\":\"not found\"}"],
    ["plain text", "nope"],
    ["an XML/SVG body", "<?xml version=\"1.0\"?><svg/>"],
  ])("rejects %s", (_label, body) => {
    expect(isSupportedFontBuffer(Buffer.from(body))).toBe(false)
  })

  it.each([
    ["TrueType 0x00010000", new Uint8Array([0x00, 0x01, 0x00, 0x00])],
    ["OTTO", sig("OTTO")],
    ["true", sig("true")],
    ["ttcf", sig("ttcf")],
    ["wOFF", sig("wOFF")],
  ])("accepts the %s signature", (_label, bytes) => {
    expect(isSupportedFontBuffer(bytes)).toBe(true)
  })

  it("rejects WOFF2 deliberately, not by oversight", () => {
    // WOFF2 is Brotli-compressed and opentype.js cannot decode it. Accepting it
    // would trade a clear rejection here for the same late throw downstream.
    expect(isSupportedFontBuffer(sig("wOF2"))).toBe(false)
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", new Uint8Array(0)],
    ["a 3-byte truncation", new Uint8Array([0x00, 0x01, 0x00])],
  ])("rejects %s without throwing", (_label, input) => {
    expect(() => isSupportedFontBuffer(input as never)).not.toThrow()
    expect(isSupportedFontBuffer(input as never)).toBe(false)
  })

  it("reads a VIEW at its own offset, not the start of the backing buffer", () => {
    // Node Buffers are frequently slices of a shared pool, so a check that reads
    // from byteOffset 0 would validate somebody else's bytes — passing or failing
    // for reasons that have nothing to do with this font.
    const backing = new Uint8Array([0xff, 0xff, 0x00, 0x01, 0x00, 0x00])
    const view = new Uint8Array(backing.buffer, 2, 4) // the TrueType signature
    expect(isSupportedFontBuffer(view)).toBe(true)
    expect(isSupportedFontBuffer(backing)).toBe(false)
  })

  it("accepts a bare ArrayBuffer as well as a view", () => {
    const ab = new Uint8Array([0x00, 0x01, 0x00, 0x00]).buffer
    expect(isSupportedFontBuffer(ab)).toBe(true)
  })
})

describe("both font loaders validate bytes, not just the response", () => {
  it.each([
    ["og/profile card", join("app", "api", "og", "profile", "[username]", "route.tsx")],
    ["trophy-case PDF", join("app", "api", "profile", "trophy-case", "pdf", "route.tsx")],
  ])("%s runs fetched font bytes through the check", (_label, rel) => {
    // A source assertion because the alternative is asserting on a render that
    // succeeds either way — the loaders are fail-soft, so "a PNG came out" is
    // true with fonts, without fonts, and with the check removed. What is
    // checkable, and what actually failed in CI, is that the bytes are gated.
    const src = readFileSync(join(process.cwd(), rel), "utf8")
    expect(src).toContain("isSupportedFontBuffer")
    // ...and the weaker predicate it replaced must not be the only gate left.
    const uncomment = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n")
    expect(
      /byteLength > 0 \? bufs : null|b\.byteLength > 0\) \? bufs/.test(uncomment),
      "the length-only font gate must be gone",
    ).toBe(false)
  })
})
