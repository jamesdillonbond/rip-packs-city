import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// The profile card's BRAND TYPOGRAPHY, proven against the real .ttf bytes.
//
// WHY THIS FILE EXISTS, SEPARATELY FROM THE RENDER SWEEP
// `api-og-cards-render-sweep` mocks global fetch, so the card's font fetch
// resolves to whatever the sweep's stub returns — which is not a font. The
// loader is fail-soft by design, so it quietly returns null, the card renders
// with `sans-serif`, and the sweep goes green having exercised NONE of the
// typography. A card that silently falls back in every test but breaks in
// production is exactly the shape this repo keeps paying for, so the fonts are
// fed here from `public/fonts` and satori is made to actually parse them.
//
// The risk being closed is specific: satori rejects font formats that a browser
// would happily render (it needs a real TrueType/OpenType table set), and a
// rejected font THROWS out of ImageResponse rather than degrading. Without this
// test the first evidence would be blank unfurls.
// ─────────────────────────────────────────────────────────────────────────────

const FONT_DIR = path.join(process.cwd(), "public", "fonts")
const DISPLAY_TTF = path.join(FONT_DIR, "BarlowCondensed-Black.ttf")
const MONO_TTF = path.join(FONT_DIR, "ShareTechMono-Regular.ttf")

vi.mock("@/lib/og/img-data", () => ({
  ogImageDataUri: vi.fn(async () => null),
  ogImageDataUris: vi.fn(async () => []),
}))

const PNG_MAGIC = "89504e470d0a1a0a"

/** PostgREST stub: one bio row with flair equipped, plus trophies. */
function supabaseRow(url: string, flair = true) {
  if (url.includes("/profile_bio"))
    return [
      {
        user_id: "u-1",
        display_name: "Trevor",
        tagline: "Blazers Team Captain",
        accent_color: "#E03A2F",
        avatar_url: null,
        favorite_team: null,
        equipped_border: flair ? "flame" : null,
        equipped_banner: flair ? "ripcity" : null,
      },
    ]
  if (url.includes("/saved_wallets"))
    return [{ cached_fmv_usd: 1500, cached_moment_count: 200, cached_badges: [] }]
  if (url.includes("/trophy_moments"))
    return [
      { slot: 1, player_name: "Damian Lillard", thumbnail_url: null, tier: "LEGENDARY" },
      { slot: 2, player_name: "Anfernee Simons", thumbnail_url: null, tier: "RARE" },
    ]
  return []
}

function installFetch(opts: { fontsOk: boolean; flair?: boolean }) {
  const realFonts: Record<string, Buffer> = {
    "BarlowCondensed-Black.ttf": fs.readFileSync(DISPLAY_TTF),
    "ShareTechMono-Regular.ttf": fs.readFileSync(MONO_TTF),
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      const fontKey = Object.keys(realFonts).find((k) => url.endsWith(k))
      if (fontKey) {
        if (!opts.fontsOk) return { ok: false, status: 503 } as never
        const buf = realFonts[fontKey]
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        } as never
      }
      return {
        ok: true,
        status: 200,
        json: async () => supabaseRow(url, opts.flair !== false),
      } as never
    }),
  )
}

/** Fresh module per case — the font promise is memoized at module scope. */
async function renderCard() {
  vi.resetModules()
  const mod = await import("@/app/api/og/profile/[username]/route")
  const res = await mod.GET({} as never, {
    params: Promise.resolve({ username: "trevor" }),
  } as never)
  const bytes = Buffer.from(await res.arrayBuffer())
  return { res, bytes }
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://db.example.co")
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "svc-key")
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.rippackscity.com")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("profile OG card — brand fonts", () => {
  it("the vendored .ttf files exist and are non-trivial", () => {
    // If someone prunes public/fonts the card silently de-brands; the trophy
    // PDF reads the same two files, so this pins both consumers.
    for (const f of [DISPLAY_TTF, MONO_TTF]) {
      expect(fs.existsSync(f)).toBe(true)
      expect(fs.statSync(f).size).toBeGreaterThan(10_000)
    }
  })

  it("satori parses the real font bytes and RENDERS DIFFERENT PIXELS with them", async () => {
    // ⚠ The obvious assertion here — "a PNG came out" — is VACUOUS, and my
    // first draft of this test shipped it. The loader is fail-soft, so a card
    // that never loads a font still returns a perfectly good PNG; stubbing
    // `loadBrandFonts` to null left all 8 cases green. The only assertion that
    // can tell branded from unbranded is the OUTPUT: Barlow Condensed does not
    // rasterise to the same bytes as satori's default face, so if these two
    // renders match, the fonts were ignored.
    installFetch({ fontsOk: true })
    const branded = await renderCard()
    installFetch({ fontsOk: false })
    const plain = await renderCard()

    expect(branded.res.status).toBe(200)
    expect(plain.res.status).toBe(200)
    expect(branded.bytes.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(plain.bytes.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(branded.bytes.byteLength).toBeGreaterThan(5_000)
    expect(branded.bytes.equals(plain.bytes)).toBe(false)
  }, 60_000)

  it("degrades to an unbranded card rather than failing when the fonts 503", async () => {
    // The whole point of fail-soft: wrong typeface beats a grey box in someone's
    // timeline. Remove the try/catch in loadBrandFonts and this reds.
    installFetch({ fontsOk: false })
    const { res, bytes } = await renderCard()
    expect(res.status).toBe(200)
    expect(bytes.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
  }, 30_000)

  it("keeps the long-cache headers so a crawler is not re-rendering the card", async () => {
    installFetch({ fontsOk: true })
    const { res } = await renderCard()
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=")
  }, 30_000)
})

describe("profile OG card — the collector's equipped flair", () => {
  it("renders differently when a border and banner are equipped", async () => {
    // Cosmetics are bought with Status and then displayed... only to the person
    // who bought them, because the card never selected the columns. They ride
    // on the SAME profile_bio row as the name, so this costs no extra read and
    // there was never a reason to omit it.
    //
    // Byte-difference again, for the same reason as the font case: asserting
    // "a PNG came out" cannot tell equipped from unequipped.
    //
    // ⚠ Fonts are held CONSTANT across the two renders. My first version varied
    // the font state as well, so the byte difference it "proved" could have
    // come entirely from the typeface — the test would have passed with the
    // flair still ignored. A difference is only evidence when exactly one thing
    // differs.
    installFetch({ fontsOk: true, flair: true })
    const withFlair = await renderCard()
    installFetch({ fontsOk: true, flair: false })
    const noFlair = await renderCard()

    expect(withFlair.bytes.equals(noFlair.bytes)).toBe(false)
  }, 60_000)
})

describe("trophyGrid — the case must be legible, not a fan of slivers", () => {
  it("sizes a single trophy as a hero", async () => {
    const { trophyGrid } = await import("@/app/api/og/profile/[username]/route")
    expect(trophyGrid(1)).toEqual({ cols: 1, w: 240, h: 317 })
  })

  it("never exceeds the 420px column at any count", async () => {
    const { trophyGrid } = await import("@/app/api/og/profile/[username]/route")
    // The shipped defect: six 220px cards inside a 420px box, offset 36px, so
    // five of them showed a 36px sliver of the thing the card exists to show.
    for (let n = 1; n <= 6; n++) {
      const g = trophyGrid(n)
      const rowWidth = g.cols * g.w + (g.cols - 1) * 12
      expect(rowWidth).toBeLessThanOrEqual(420)
      // ...and must still command the column rather than huddle in a corner.
      // A lone trophy sits at exactly 240 by design — big enough to read as a
      // hero without stretching one thumbnail across the whole panel — so the
      // floor is >=, not >. (My first pass asserted >, which red on n=1 and
      // would have pushed the single-trophy card wider than it should be.)
      expect(rowWidth).toBeGreaterThanOrEqual(240)
    }
  })

  it("fits every pinned trophy inside the 380px height", async () => {
    const { trophyGrid } = await import("@/app/api/og/profile/[username]/route")
    for (let n = 1; n <= 6; n++) {
      const g = trophyGrid(n)
      const rows = Math.ceil(n / g.cols)
      expect(rows * g.h + (rows - 1) * 12).toBeLessThanOrEqual(380)
    }
  })

  it("clamps a nonsense count instead of dividing by zero", async () => {
    const { trophyGrid } = await import("@/app/api/og/profile/[username]/route")
    expect(trophyGrid(0).cols).toBe(1)
    expect(trophyGrid(99).cols).toBe(3)
  })
})
