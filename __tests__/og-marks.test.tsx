import { describe, it, expect, afterEach } from "vitest"
import { ImageResponse } from "next/og"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OgMark, type MarkName } from "@/lib/og/marks"

/**
 * THE MARK VOCABULARY, ASSERTED AS PIXELS RATHER THAN AS SOURCE.
 *
 * `lib/og/marks.tsx` exists so an OG card never renders a glyph next/og has to
 * fetch — Twemoji from cdn.jsdelivr.net for an emoji, a Google Fonts stylesheet
 * for anything the brand fonts miss, both at RENDER time on the path a social
 * crawler waits on. A source-level check of that claim is circular: the module
 * is where the claim is written. So every case here RENDERS through the real
 * `ImageResponse` with the network closed, exactly as `api-og-cards-render-
 * sweep` does, and reads the resulting bytes.
 *
 * ⚠ THE FETCH STUB THROWS RATHER THAN RETURNING A STUB RESPONSE, ON PURPOSE.
 * Serving a placeholder SVG is what hid this defect for weeks: the sweep stubbed
 * `twemoji`, stayed green, and the cards kept reaching the CDN in production.
 * Verified 2026-08-29 that a throwing fetch makes the render REJECT rather than
 * silently drop the glyph — so "no fetch" here is enforced, not hoped for.
 *
 * ⚠ Non-http(s) is delegated to the real fetch: `next/og` loads its Satori and
 * resvg WebAssembly through this same global, and a blanket stub hands the
 * error object to `WebAssembly.instantiate`, failing every case for a reason
 * that has nothing to do with the marks.
 */

const PNG_MAGIC = "89504e470d0a1a0a"

/**
 * Every mark. Listed EXPLICITLY rather than derived from the module, so adding a
 * mark is a conscious "add it to the test" step — a list derived from the thing
 * under test cannot notice that the thing under test grew.
 */
const ALL: MarkName[] = [
  "target",
  "star",
  "pack",
  "burst",
  "bag",
  "diamond",
  "trophy",
  "bolt",
  "stack",
  "coin",
  "arrow",
]

/** The two vendored brand fonts, as production supplies them. */
function brandFontsLocal() {
  const dir = join(__dirname, "..", "public", "fonts")
  return [
    {
      name: "Barlow Condensed",
      data: readFileSync(join(dir, "BarlowCondensed-Black.ttf")),
      weight: 900 as const,
      style: "normal" as const,
    },
    {
      name: "Share Tech Mono",
      data: readFileSync(join(dir, "ShareTechMono-Regular.ttf")),
      weight: 400 as const,
      style: "normal" as const,
    },
  ]
}

let originalFetch: typeof globalThis.fetch | undefined

async function renderMark(
  name: MarkName,
  { size = 48, color = "#FF6B35" }: { size?: number; color?: string } = {},
): Promise<{ bytes: Buffer; escapes: string[] }> {
  originalFetch = globalThis.fetch
  const escapes: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    if (/^https?:/i.test(url)) {
      escapes.push(url)
      throw new Error(`mark render escaped to the network: ${url}`)
    }
    return originalFetch!(input as never, init)
  }) as unknown as typeof globalThis.fetch

  try {
    const res = new ImageResponse(
      (
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            background: "#0A0A0D",
          }}
        >
          <OgMark name={name} size={size} color={color} />
        </div>
      ),
      { width: 80, height: 80, fonts: brandFontsLocal() as never },
    )
    return { bytes: Buffer.from(await res.arrayBuffer()), escapes }
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function renderBlank(): Promise<Buffer> {
  const res = new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", background: "#0A0A0D" }} />,
    { width: 80, height: 80, fonts: brandFontsLocal() as never },
  )
  return Buffer.from(await res.arrayBuffer())
}

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch
})

describe("OG marks", () => {
  it("renders every mark to real PNG bytes with ZERO network calls", async () => {
    // The empty-canvas CONTROL, rendered through the same harness. "Drew
    // something" is then an exact comparison rather than a guessed byte floor —
    // the first draft of this test asserted `> 900` from a guess and failed on
    // `trophy` at 896, which is the whole failure mode this repo keeps
    // recording: a threshold nobody measured reads as a property.
    const blank = await renderBlank()
    for (const name of ALL) {
      const { bytes, escapes } = await renderMark(name)
      expect(escapes, `${name} reached the network`).toEqual([])
      expect(bytes.subarray(0, 8).toString("hex"), `${name} is not a PNG`).toBe(PNG_MAGIC)
      expect(bytes.equals(blank), `${name} drew nothing`).toBe(false)
      // Belt as well as braces: a single stray pixel also differs from blank.
      // MEASURED 2026-08-29 at 80x80, mark size 48 — blank 334 bytes; marks 426
      // (stack) 485 (arrow) 896 (trophy) … 1516 (star). `stack` and `arrow` sit
      // low because axis-aligned runs compress; 400 is under the smallest mark
      // and over the blank, and every number in that range is a sample, not a
      // constant — re-measure before moving it.
      expect(bytes.length, `${name} rendered near-nothing`).toBeGreaterThan(400)
    }
  }, 120_000)

  it("no two marks render the same image", async () => {
    // Cheap insurance against the copy-paste failure this module invites: eleven
    // near-identical `case` arms, each a path string. A duplicated `d` attribute
    // is invisible in review and invisible in a PNG byte count — two
    // achievements would simply wear the same badge. Comparing the rendered
    // bytes catches it; comparing the source would not, because two DIFFERENT
    // path strings can still draw the same shape.
    const seen = new Map<string, MarkName>()
    for (const name of ALL) {
      const { bytes } = await renderMark(name)
      const key = bytes.toString("base64")
      const clash = seen.get(key)
      expect(clash, `${name} renders identically to ${clash}`).toBeUndefined()
      seen.set(key, name)
    }
    expect(seen.size).toBe(ALL.length)
  }, 120_000)

  it("the colour prop reaches the pixels", async () => {
    // A mark that ignored `color` would render — and would render the WRONG
    // thing on every card, since each one passes its own accent. The profile
    // badge row depends on this specifically: after 2026-08-29 the mark itself
    // carries the achievement tier, so a mark that dropped the prop would erase
    // bronze/silver/gold/platinum entirely while still producing a valid PNG.
    const a = await renderMark("trophy", { color: "#FF6B35" })
    const b = await renderMark("trophy", { color: "#00D4AA" })
    expect(a.bytes.equals(b.bytes)).toBe(false)
  }, 120_000)

  it("renders at the sizes the cards actually use", async () => {
    // 13 on insights/serial-premiums, 15 in the deal badge pill, 20 in the
    // profile achievement row, 26 in the pack/lifecycle eyebrow, 28 on the deal
    // header. A mark that only works at its 24px reference is not a fix.
    for (const size of [13, 15, 20, 26, 28]) {
      const { bytes, escapes } = await renderMark("target", { size })
      expect(escapes).toEqual([])
      expect(bytes.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    }
  }, 120_000)

  it("a glyph in the same position WOULD have escaped (positive control)", async () => {
    // Without this, every case above passes just as well if `ImageResponse` had
    // quietly stopped fetching anything at all — a green run would say nothing
    // about the marks. Rendering the character the mark replaced, through the
    // same harness, proves the harness can still see the failure.
    originalFetch = globalThis.fetch
    const escapes: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      if (/^https?:/i.test(url)) {
        escapes.push(url)
        throw new Error(`escaped: ${url}`)
      }
      return originalFetch!(input as never, init)
    }) as unknown as typeof globalThis.fetch

    // U+1F3AF DIRECT HIT — what /api/og/deal rendered before the target mark.
    const emoji = String.fromCodePoint(0x1f3af)
    await expect(
      new ImageResponse(
        <div style={{ display: "flex", background: "#0A0A0D", fontSize: 28 }}>{emoji}</div>,
        { width: 80, height: 80, fonts: brandFontsLocal() as never },
      ).arrayBuffer(),
    ).rejects.toThrow(/escaped/)
    expect(escapes.some((u) => u.includes("twemoji"))).toBe(true)

    globalThis.fetch = originalFetch
  }, 120_000)
})
