import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { installOgCapture, resetOgCapture, ogText, type OgCapture } from "./helpers/og-capture"

import { trophyGrid } from "@/app/api/og/profile/[username]/route"
import { monoCharBudget } from "@/lib/og/trophy-detail"

// ─────────────────────────────────────────────────────────────────────────────
// THE PROFILE CARD NAMES ITS TROPHIES (shipped 2026-09-13).
//
// Until today every tile on the most-shared surface in the product said
// "#46 / 199 RARE" and nothing else — an impressive number about an
// unidentified object. `player_name` was already on the row and already
// fetched; its only appearance in the render path was a `console.warn`.
//
// Three properties are pinned here, and they fail independently:
//
//  1. THE NAME IS DRAWN. Trivially checkable, and the one a revert would break.
//  2. ⭐ EACH NAME SITS WITH ITS OWN ROW'S SERIAL. This is the misattribution
//     class that captioned Kevin Durant's art "Amon-Ra St. Brown" on the sibling
//     trophy-case card (2026-09-12) — there, a compacting art prefetch shifted
//     every image after a failure into the previous slot while the caption was
//     read by position. On this card the name travels WITH the row (`...t` in
//     the same object as the art), so the defect is structurally impossible —
//     and a future refactor that reads names from a parallel array must red.
//  3. THE CLAMP CUTS THE TAIL, NEVER THE HEAD. A centred flex line with
//     `overflow: hidden` eats BOTH ends: the first render of this strip drew a
//     44-character UFC title as "Adesanya vs Alex Pereira UFC 2", silently
//     losing "Israel " off the FRONT. Character-count clipping (lib/og/
//     trophy-detail.ts `clip`) is what holds, because satori no-ops
//     `text-overflow: ellipsis` often enough that CSS cannot be trusted here.
//
// ⚠ The budget itself is asserted against the SHIPPED FONT FILE, not restated —
// same instrument as __tests__/og-trophy-caption-fits-its-tile.test.ts, because
// nothing else in CI measures layout (jsdom boxes are zero).
// ─────────────────────────────────────────────────────────────────────────────

const ART =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const capture: { c: OgCapture | null } = { c: null }

/** The card's own caption scale, read from the route's formula. */
function capSizeFor(w: number): number {
  return Math.max(10, Math.min(14, Math.round(w / 17)))
}

/** Modal glyph advance straight from the TTF the card ships. */
function monoAdvanceEm(): number {
  const b = readFileSync(path.join(process.cwd(), "public/fonts/ShareTechMono-Regular.ttf"))
  const numTables = b.readUInt16BE(4)
  const tables: Record<string, number> = {}
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16
    tables[b.toString("ascii", o, o + 4)] = b.readUInt32BE(o + 8)
  }
  const upem = b.readUInt16BE(tables["head"] + 18)
  const numH = b.readUInt16BE(tables["hhea"] + 34)
  const counts = new Map<number, number>()
  for (let i = 0; i < numH; i++) {
    const a = b.readUInt16BE(tables["hmtx"] + i * 4)
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  const [advance] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]
  return advance / upem
}

function rows(names: string[], serials?: number[]) {
  return names.map((n, i) => ({
    slot: i + 1,
    player_name: n,
    tier: "LEGENDARY",
    serial_number: serials?.[i] ?? i + 1,
    circulation_count: 199,
    thumbnail_url: `https://assets.nbatopshot.com/media/${i}/image?width=180`,
  }))
}

function installFetch(names: string[], serials?: number[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes("/rpc/get_trophy_slab_data_by_username"))
        return { ok: true, status: 200, json: async () => rows(names, serials) } as never
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
      return { ok: false, status: 404 } as never
    }),
  )
}

async function render(names: string[], serials?: number[]) {
  installFetch(names, serials)
  vi.resetModules()
  resetOgCapture()
  capture.c = installOgCapture()
  vi.doMock("@/lib/og/img-data", () => ({
    ogImageDataUri: async (u: string | null) => (u ? ART : null),
    ogImageDataUris: async (us: string[]) => us.map(() => ART),
    ogImageDataUriSlots: async (us: string[]) => us.map(() => ART),
  }))
  const mod = await import("@/app/api/og/profile/[username]/route")
  await mod.GET({} as never, { params: Promise.resolve({ username: "trevor" }) } as never)
  return ogText(capture.c!.element())
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock("@/lib/og/img-data")
  vi.restoreAllMocks()
  resetOgCapture()
})

describe("the profile card names the Moments it draws", () => {
  it("prints every pinned Moment's player name", async () => {
    const text = await render(["Victor Wembanyama", "LeBron James", "Jude Bellingham"])
    expect(text).toContain("Victor Wembanyama")
    expect(text).toContain("LeBron James")
    expect(text).toContain("Jude Bellingham")
  }, 30_000)

  it("⭐ pairs each name with ITS OWN serial, not with a neighbour's", async () => {
    // The misattribution shape, stated as an assertion rather than as a comment:
    // distinct serials per row, so a name read by a shifted index cannot pass.
    const text = await render(["Wemby", "LeBron", "Bellingham"], [11, 22, 33])
    expect(text).toContain("Wemby #11 / 199")
    expect(text).toContain("LeBron #22 / 199")
    expect(text).toContain("Bellingham #33 / 199")
  }, 30_000)

  it("clips the TAIL of an over-long name and never the head", async () => {
    const long = "Israel Adesanya vs Alex Pereira UFC 287 Main"
    const text = await render([long])
    expect(text).not.toContain(long) // it must actually be clipped
    expect(text).toContain("Israel Adesanya") // ...from the front
    expect(text).toContain("…") // ...with a real ellipsis, not a hard cut
    // ⛔ The both-ends failure, pinned by its signature: the head is what the
    // centred-overflow version dropped.
    expect(text).not.toContain("Adesanya vs Alex Pereira UFC 2 ")
  }, 30_000)

  it("draws no name strip for a Moment whose name is missing", async () => {
    // A card that prints an empty caption band claims a name it does not have.
    const text = await render([""])
    expect(text).toContain("#1 / 199")
  }, 30_000)
})

describe("the name budget fits the slab it is measured against", () => {
  const em = monoAdvanceEm()

  it("the shipped face is still 0.540em — the divisor the budget is built on", () => {
    expect(em.toFixed(3)).toBe("0.540")
  })

  it("every trophy grid the card can draw holds its name on ONE line", () => {
    // ⚠ Over the TREE of cases the route can actually produce (1..6 pinned),
    // not over the two anyone has pinned today — 4 of 7 collectors pin one and
    // 3 pin six, and the 2/3/5 widths exist precisely for the day that changes.
    for (let n = 1; n <= 6; n++) {
      const { w } = trophyGrid(n)
      const size = capSizeFor(w)
      const used = monoCharBudget(w - 8, size) * (em * size + 0.4)
      expect(used, `${n} pinned (w=${w}, ${size}px): ${used.toFixed(1)}px of name in ${w - 8}px`)
        .toBeLessThanOrEqual(w - 8)
    }
  })

  it("a budget of zero width asks for no characters rather than a negative slice", () => {
    expect(monoCharBudget(0, 10)).toBe(0)
    expect(monoCharBudget(-10, 10)).toBe(0)
  })
})
