import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// lib/og/brand-fonts — the shared loader, and a ratchet on the cards using it.
//
// Two separate failures live here, and both had already happened once:
//
// 1. NO CACHE HEADERS. 42 of 43 cards were `force-dynamic` with no
//    Cache-Control, so every crawler fetch re-ran a satori render plus its DB
//    reads. X's crawler abandons a slow image, so this is not just cost — it is
//    links that unfurl with no picture.
//
// 2. THE FONTS SILENTLY NOT LOADING. The loader is fail-soft by contract, so a
//    card that never gets a font still renders a perfect PNG. Every "does it
//    render" assertion passes straight through the regression. The per-card
//    proof (bytes differ with fonts on vs off) lives in
//    api-og-profile-brand-fonts; here we pin the loader's own contract and
//    ratchet how many cards are wired to it.
// ─────────────────────────────────────────────────────────────────────────────

const OG_DIR = path.join(process.cwd(), "app", "api", "og")

function ogRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) ogRouteFiles(p, acc)
    else if (e.name === "route.tsx") acc.push(p)
  }
  return acc
}

const ttf = (n: string) => fs.readFileSync(path.join(process.cwd(), "public", "fonts", n))
const toAb = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

function stubFetch(mode: "font" | "html" | "404" | "throw") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown) => {
      if (mode === "throw") throw new Error("offline")
      if (mode === "404") return { ok: false, status: 404 } as never
      const body =
        mode === "html"
          ? // The exact shape that broke production: an SSO/login interstitial
            // served with a 200, which `res.ok` and `byteLength > 0` both accept.
            Buffer.from("<!DOCTYPE html><html><body>Sign in</body></html>")
          : ttf(String(u).endsWith("ShareTechMono-Regular.ttf")
              ? "ShareTechMono-Regular.ttf"
              : "BarlowCondensed-Black.ttf")
      return { ok: true, status: 200, arrayBuffer: async () => toAb(body) } as never
    }),
  )
}

async function freshModule() {
  vi.resetModules()
  return import("@/lib/og/brand-fonts")
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.rippackscity.com"))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("brandFonts", () => {
  it("returns both faces from real font bytes", async () => {
    stubFetch("font")
    const { brandFonts, DISPLAY_FONT, MONO_FONT } = await freshModule()
    const f = await brandFonts()
    expect(f?.map((x) => x.name)).toEqual([DISPLAY_FONT, MONO_FONT])
    expect(f?.every((x) => x.data.byteLength > 10_000)).toBe(true)
  })

  it("REJECTS an HTML body served with a 200", async () => {
    // The production incident: /fonts/*.ttf sat behind the auth wall, so the
    // fetch got the sign-in page. satori then throws `Unsupported OpenType
    // signature <!DO` from inside the response STREAM — after the handler has
    // returned, where no try/catch in the route can reach it. Validating the
    // response was never enough; the bytes have to be checked.
    stubFetch("html")
    const { brandFonts } = await freshModule()
    expect(await brandFonts()).toBeUndefined()
  })

  it.each([["404"], ["throw"]] as const)("degrades to undefined on %s", async (mode) => {
    stubFetch(mode)
    const { brandFonts } = await freshModule()
    expect(await brandFonts()).toBeUndefined()
  })

  it("memoizes, so a warm invocation pays the fetch once", async () => {
    stubFetch("font")
    const { brandFonts } = await freshModule()
    await brandFonts()
    const calls = (globalThis.fetch as any).mock.calls.length
    await brandFonts()
    expect((globalThis.fetch as any).mock.calls.length).toBe(calls)
  })

  it("brandFamilies falls back to a generic face rather than a missing one", async () => {
    const { brandFamilies, DISPLAY_FONT, MONO_FONT } = await freshModule()
    expect(brandFamilies(undefined)).toEqual({ display: "sans-serif", mono: "sans-serif" })
    const named = brandFamilies([{ name: DISPLAY_FONT }] as never)
    expect(named).toEqual({ display: DISPLAY_FONT, mono: MONO_FONT })
  })
})

describe("OG card adoption ratchet", () => {
  const files = ogRouteFiles(OG_DIR)
  const sources = files.map((f) => ({ f, src: fs.readFileSync(f, "utf8") }))

  it("finds the OG tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(40)
  })

  // A ratchet rather than a ban: 29 of these are insights boards that share no
  // renderer, so converting them is its own pass. Freezing the count means a
  // NEW card has to make a conscious choice, and a conversion that regresses
  // reds — without pretending the family is finished.
  const branded = sources.filter((s) => s.src.includes("@/lib/og/brand-fonts"))

  it("keeps at least the converted cards on the shared loader", () => {
    // 9 ROUTE FILES, covering 14 cards — the five entity cards
    // (edition/set/series/team/player) import nothing themselves because they
    // render through lib/og/entity-card.tsx, which is asserted separately
    // below. Counting route files and calling it "9 of 43 branded" would
    // undercount the actual coverage; counting cards and asserting it here
    // would make this walk lie about what it measured.
    expect(branded.length).toBeGreaterThanOrEqual(9)
  })

  it("names the cards that must never regress", () => {
    // The shared entity renderer covers edition/set/series/team/player, so it
    // is listed instead of its five callers.
    const must = [
      "og/profile",
      "og/share",
      "og/moment",
      "og/deal",
      "og/collection",
      "og/default",
      "og/pack/route",
      "og/pack/lifecycle",
      "og/fast-break",
    ]
    const brandedPaths = branded.map((s) => s.f.replace(/\\/g, "/"))
    for (const m of must) {
      expect(
        brandedPaths.some((p) => p.includes("api/" + m)),
        `${m} lost its brand fonts`,
      ).toBe(true)
    }
    const entity = fs.readFileSync(path.join(process.cwd(), "lib", "og", "entity-card.tsx"), "utf8")
    expect(entity).toContain("@/lib/og/brand-fonts")
  })

  it("every branded card also sets a shared cache policy", () => {
    // The two travel together deliberately: a card expensive enough to want
    // brand fonts is a card no crawler should be re-rendering per fetch.
    //
    // ⚠ Asserted on the body with IMPORT LINES STRIPPED. The obvious
    // `src.includes("OG_CACHE_HEADERS")` is satisfied by the import statement
    // alone, so deleting the actual `headers:` option left this green — caught
    // by mutating it, not by reading it. A symbol being imported is not
    // evidence that it is used.
    for (const { f, src } of branded) {
      const body = src.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "")
      expect(body.includes("OG_CACHE_HEADERS"), `${f} has fonts but no cache headers`).toBe(true)
    }
  })

  it("no branded card still hardcodes a generic font family", () => {
    // The exact way a "converted" card silently keeps its old face: the import
    // lands, the ternary never gets applied to the style.
    for (const { f, src } of branded) {
      expect(
        /fontFamily:\s*"(?:sans-serif|system-ui|monospace)"/.test(src),
        `${f} imports the brand fonts but still hardcodes a generic family`,
      ).toBe(false)
    }
  })
})
