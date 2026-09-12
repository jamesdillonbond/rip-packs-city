import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// THE PROFILE CARD MUST NOT CLAIM SIX AND DRAW FOUR.
//
// The card prints "N / 6  TROPHY CASE" from the RPC's row count and draws the
// case from the post-art-prefetch array. Nothing compared the two, so a trophy
// whose ARTWORK failed to fetch silently vanished from the case while the label
// kept asserting it — and two whole collections failed permanently:
//
//   * Disney Pinnacle art is addressed as a SITE-RELATIVE path, which the
//     prefetcher's `^https?://` gate rejected outright.
//   * All 6,190 NFL All Day editions are addressed `format=webp`, which the
//     prefetcher drops on purpose (satori cannot decode it).
//
// Both causes are fixed in lib/og/img-data.ts (2026-09-12) and pinned in
// og-img-data.test.ts. This file pins the OTHER half — that the card survives
// the NEXT upstream format change honestly, by drawing a named placeholder
// rather than a shorter case.
//
// ⚠ It asserts by BYTES, on renders that differ only in WHICH art failed,
// because "does the card render" passes straight through the defect: the
// dropped-tile card renders perfectly well, it is just wrong.
// ─────────────────────────────────────────────────────────────────────────────

// A real 1×1 PNG — satori actually decodes the art, so an invented data URI
// throws from inside the renderer rather than failing the assertion.
const ART =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/** Indices whose art fails this render. */
let failing = new Set<number>()
let seen: string[] = []
vi.mock("@/lib/og/img-data", () => ({
  ogImageDataUri: vi.fn(async (url: string | null) => {
    if (!url) return null
    const i = seen.length
    seen.push(url)
    return failing.has(i) ? null : ART
  }),
  ogImageDataUris: vi.fn(async (urls: string[]) => urls.map(() => ART)),
  ogImageDataUriSlots: vi.fn(async (urls: string[]) => urls.map(() => ART)),
}))

const PNG_MAGIC = "89504e470d0a1a0a"

const trophyRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    slot: i + 1,
    player_name: `Player ${i}`,
    tier: "LEGENDARY",
    thumbnail_url: `https://assets.nbatopshot.com/media/${i}/image?width=180`,
  }))

function installFetch(n: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes("/rpc/get_trophy_slab_data_by_username"))
        return { ok: true, status: 200, json: async () => trophyRows(n) } as never
      if (url.includes("/profile_bio"))
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              user_id: "u-1",
              display_name: "Trevor",
              tagline: null,
              accent_color: "#E03A2F",
              avatar_url: null,
              favorite_team: null,
              equipped_border: null,
              equipped_banner: null,
            },
          ],
        } as never
      if (url.includes("/saved_wallets"))
        return {
          ok: true,
          status: 200,
          json: async () => [{ cached_fmv_usd: 100, cached_moment_count: 10, cached_badges: [] }],
        } as never
      // Fonts and everything else: fail soft, the card renders unbranded.
      return { ok: false, status: 404 } as never
    }),
  )
}

async function render(n: number, fails: number[]) {
  failing = new Set(fails)
  seen = []
  installFetch(n)
  vi.resetModules()
  const mod = await import("@/app/api/og/profile/[username]/route")
  const res = await mod.GET({} as never, {
    params: Promise.resolve({ username: "trevor" }),
  } as never)
  return Buffer.from(await res.arrayBuffer())
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("profile card — a trophy whose art failed keeps its slab", () => {
  it("renders differently depending on WHICH trophy lost its art", async () => {
    // Under the drop-the-tile behaviour these two are BYTE-IDENTICAL: both
    // collapse to five slabs in the same five positions, and the identity of
    // the missing Moment is erased. A placeholder makes them distinguishable,
    // which is the same thing as saying the card no longer hides the loss.
    const firstMissing = await render(6, [0])
    const lastMissing = await render(6, [5])
    expect(firstMissing.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(lastMissing.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(firstMissing.equals(lastMissing)).toBe(false)
  }, 30_000)

  it("draws a six-trophy case even when two upstreams are dead", async () => {
    // The exact live shape on 2026-09-12: slots 4 and 5 (All Day, Pinnacle).
    const twoDead = await render(6, [3, 4])
    const allArt = await render(6, [])
    const fourPinned = await render(4, [])
    expect(twoDead.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(twoDead.equals(allArt)).toBe(false)
    // ...and it must NOT collapse into the card a collector with four pinned
    // trophies gets. That is precisely the confusion the drop produced.
    expect(twoDead.equals(fourPinned)).toBe(false)
  }, 30_000)

  it("names the dropped Moments and their URLs on the way out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await render(6, [3])
    const line = warn.mock.calls.map((c) => c.join(" ")).join("\n")
    // The URL is the whole diagnosis — a relative path and a `format=webp` are
    // each self-explaining once someone can see them.
    expect(line).toContain("Player 3")
    expect(line).toContain("/media/3/image")
    expect(line).toContain("1/6")
  }, 30_000)
})
