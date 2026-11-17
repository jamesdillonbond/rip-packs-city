/**
 * Is this buffer actually a font?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Two routes fetch the vendored brand fonts over HTTP at render time
 * (`app/api/og/profile/[username]` and `app/api/profile/trophy-case/pdf`). Both
 * loaders validated the RESPONSE — `res.ok` and a non-zero byteLength — and
 * neither validated the BYTES. Any 200 whose body is not a font passes both
 * checks: a CDN error page, a redirect landing on HTML, or the SSO interstitial
 * Vercel serves in front of a protected preview (a documented behaviour of this
 * project's preview URLs). satori is then handed an HTML document and throws
 * `Unsupported OpenType signature <!DO` — the first four bytes of `<!DOCTYPE`.
 *
 * ⚠ AND THE EXISTING SAFETY NET CANNOT CATCH IT, which is the part worth
 * knowing. `app/api/og/profile` wraps its render in a try/catch that falls back
 * to an unbranded card precisely because "a font satori rejects THROWS rather
 * than degrading". That reasoning is right and the guard is in the wrong place:
 * `new ImageResponse(...)` returns a Response whose body is a STREAM, so satori
 * runs when the body is consumed — after `GET` has already returned. The throw
 * escapes the handler entirely and no `catch` around the constructor will ever
 * see it. The fallback is inert against the one failure it was written for.
 *
 * So the check has to happen BEFORE the bytes reach the renderer, and it has to
 * be a property of the bytes themselves. Failing here is fail-soft in the way
 * the loaders already promise: no fonts means an unbranded card, which beats a
 * broken one.
 */

/**
 * Signatures satori / @vercel/og (via opentype.js) can actually parse.
 *
 * `0x00010000` TrueType · `OTTO` CFF/OpenType · `true`/`ttcf` legacy + collection
 * · `wOFF` WOFF1. **`wOF2` is deliberately absent** — WOFF2 is Brotli-compressed
 * and opentype.js does not decode it, so accepting it here would swap a clear
 * rejection for the same late throw this module exists to prevent.
 */
const SIGNATURES: readonly number[] = [
  0x00010000, // TrueType outlines
  0x4f54544f, // 'OTTO'
  0x74727565, // 'true'
  0x74746366, // 'ttcf'
  0x774f4646, // 'wOFF'
]

/**
 * True when `buf` starts with a font signature satori can parse.
 *
 * Deliberately accepts `ArrayBuffer` or any `ArrayBufferView` (Node `Buffer`
 * included) because the two callers hold different shapes — the OG card keeps
 * `ArrayBuffer`s for `ImageResponse`, the PDF route keeps `Buffer`s for pdf-lib
 * — and forcing one to convert just to be checked invites the check being
 * skipped.
 */
export function isSupportedFontBuffer(buf: ArrayBuffer | ArrayBufferView | null | undefined): boolean {
  if (!buf) return false
  const view =
    buf instanceof ArrayBuffer
      ? new DataView(buf)
      : new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.byteLength < 4) return false
  return SIGNATURES.includes(view.getUint32(0, false))
}
