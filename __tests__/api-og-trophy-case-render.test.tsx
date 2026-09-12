import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

// ⚠ The render sweep proves only that SOME PNG came out — and this card has a
// branded fallback that also produces one. So the sweep cannot tell "rendered
// the collector's six Moments" from "fell back". Same trap as the fail-soft
// font loader, twice already this session. The assertion that discriminates is
// that a card WITH trophies differs in bytes from the empty case.

const getPublicProfile = vi.fn()
vi.mock("@/lib/profile/public-profile", () => ({
  getPublicProfile: (...a: unknown[]) => getPublicProfile(...a),
}))

// ⚠ A REAL 1×1 PNG, not a truncated base64 stub. satori actually DECODES
// the art, so an invented data URI throws `RangeError: Offset is outside the
// bounds of the DataView` from inside the renderer — a fixture that cannot
// exist, failing in a way that looks like a bug in the code under test.
const ART =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
// Which slot's art fails, if any. Set per test; -1 means every slot resolves.
let failingSlot = -1
vi.mock("@/lib/og/img-data", () => ({
  ogImageDataUri: vi.fn(async () => ART),
  ogImageDataUris: vi.fn(async (urls: string[]) => urls.map(() => ART)),
  ogImageDataUriSlots: vi.fn(async (urls: string[]) =>
    urls.map((_, i) => (i === failingSlot ? null : ART)),
  ),
}))

const PNG_MAGIC = "89504e470d0a1a0a"

// The jersey-number read the badge row makes. `jerseyRows` is swapped per test;
// `jerseyFails` drives the degraded path.
let jerseyRows: Array<{ external_id: string; collection_id: string; jersey_number: number | null }> = []
let jerseyFails = false
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: () => ({
          limit: async () =>
            jerseyFails ? { data: null, error: { message: "down" } } : { data: jerseyRows, error: null },
        }),
      }),
    }),
  },
}))

const payload = (n: number) => ({
  ok: true as const,
  data: {
    username: "trevor",
    bio: { display_name: "Trevor", accent_color: "#E03A2F", equipped_border: null },
    trophies: Array.from({ length: n }, (_, i) => ({
      slot: i + 1,
      moment_id: `m${i}`,
      player_name: `Player ${i}`,
      tier: "LEGENDARY",
      thumbnail_url: "https://assets.nbatopshot.com/x.jpg",
      // Nothing earned by default, so a test that wants a badge has to say so
      // and cannot pass on a fixture's accident.
      badges: null,
      serial_number: 12,
      circulation_count: 50,
      edition_id: `ed-${i}`,
      collection_id: "c-1",
    })),
    wallets: [],
  },
})

async function render() {
  vi.resetModules()
  const mod = await import("@/app/api/og/trophy-case/[username]/route")
  const res = await mod.GET({} as never, {
    params: Promise.resolve({ username: "trevor" }),
  } as never)
  return Buffer.from(await res.arrayBuffer())
}

beforeEach(() => {
  failingSlot = -1
  jerseyRows = []
  jerseyFails = false
  getPublicProfile.mockReset()
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })))
})
afterEach(() => vi.unstubAllGlobals())

describe("trophy-case OG card renders the actual case", () => {
  it("a case with trophies differs from an empty one", async () => {
    getPublicProfile.mockResolvedValue(payload(6))
    const full = await render()
    getPublicProfile.mockResolvedValue(payload(0))
    const empty = await render()

    expect(full.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(empty.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(full.equals(empty)).toBe(false)
    expect(full.byteLength).toBeGreaterThan(5_000)
  }, 30_000)

  it("a failed read still yields a real card rather than a 500", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 500, error: "boom" })
    const bytes = await render()
    expect(bytes.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
  }, 30_000)

  // ⚠ THE ASSERTION THAT CATCHES A MISATTRIBUTED MOMENT, and the reason it is
  // shaped as a differential rather than "does it render".
  //
  // This card captions every tile with `player_name`. It used to prefetch art
  // with `ogImageDataUris`, which DROPS failures and closes the gap, then read
  // `uris[i]` alongside `rows[i]` — so one failure slid every later image one
  // slot forward and the card published one collector's Moment under another
  // player's name. Live on 2026-09-12 that was Kevin Durant's art captioned
  // "Amon-Ra St. Brown", because All Day art failed for a whole other reason.
  //
  // Under the compacting read these two renders are BYTE-IDENTICAL: both
  // collapse to the same five tiles under the same first five names, and only
  // the (invisible) pairing differs. Under the slot-preserving read the
  // placeholder lands in a different position, so they cannot match. That is
  // why this asserts inequality between two failures rather than asserting a
  // card renders — a "did it render" test passes straight through the bug.
  it("does not slide art onto the next trophy's name when one image fails", async () => {
    getPublicProfile.mockResolvedValue(payload(6))
    failingSlot = 0
    const firstMissing = await render()
    failingSlot = 5
    const lastMissing = await render()

    expect(firstMissing.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(lastMissing.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(firstMissing.equals(lastMissing)).toBe(false)
  }, 30_000)

  // The trophy is pinned; only its picture is unavailable. A case that quietly
  // draws five slabs for six pinned Moments is the silent-drop defect — it was
  // how two whole collections went missing for a month without anyone noticing.
  it("still draws a tile for a trophy whose art could not be fetched", async () => {
    getPublicProfile.mockResolvedValue(payload(6))
    failingSlot = -1
    const allArt = await render()
    failingSlot = 2
    const oneMissing = await render()

    expect(oneMissing.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    // A placeholder tile is drawn, not a shorter shelf: the card still differs
    // from the all-art render (something changed) AND from the empty case.
    expect(oneMissing.equals(allArt)).toBe(false)
    getPublicProfile.mockResolvedValue(payload(0))
    const empty = await render()
    expect(oneMissing.equals(empty)).toBe(false)
  }, 30_000)

  it("carries the long cache headers", async () => {
    getPublicProfile.mockResolvedValue(payload(3))
    vi.resetModules()
    const mod = await import("@/app/api/og/trophy-case/[username]/route")
    const res = await mod.GET({} as never, {
      params: Promise.resolve({ username: "trevor" }),
    } as never)
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=")
  }, 30_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// BADGES — Trevor, 2026-09-12: the share image "needs to also include
// edition-wide badges … along with special serial badges, for each moment
// displayed."
//
// This card has no text per badge, so the assertions are differential: a case
// whose Moments have earned something must not render identically to one whose
// Moments have not. Weaker than the moment card's label assertions, and the
// reason `og-share-cards-draw-moment-badges` pins the derivation directly.
// ─────────────────────────────────────────────────────────────────────────────
describe("trophy-case card — badges reach the render", () => {
  it("a case whose Moments carry badges differs from one whose Moments do not", async () => {
    getPublicProfile.mockResolvedValue(payload(3))
    const bare = await render()

    const withBadges = payload(3)
    withBadges.data.trophies[0].badges = ["Three-Star Rookie"] as never
    getPublicProfile.mockResolvedValue(withBadges)
    const badged = await render()

    expect(badged.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(badged.equals(bare)).toBe(false)
  }, 30_000)

  it("a special serial reaches the render with no badge data at all", async () => {
    // #1 and perfect mint are computed from the trophy row — no read, no
    // badges array, and they must still draw.
    getPublicProfile.mockResolvedValue(payload(3))
    const bare = await render()

    const first = payload(3)
    first.data.trophies[0].serial_number = 1 as never
    getPublicProfile.mockResolvedValue(first)
    const medal = await render()
    expect(medal.equals(bare)).toBe(false)
  }, 30_000)

  it("⚠ still renders a real card when the jersey read fails", async () => {
    // Costs the jersey glyph and nothing else. A decoration read must never
    // take the card down with it.
    jerseyFails = true
    const p = payload(3)
    p.data.trophies[0].badges = ["Rookie Year"] as never
    getPublicProfile.mockResolvedValue(p)
    const bytes = await render()
    expect(bytes.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC)
    expect(bytes.byteLength).toBeGreaterThan(5_000)
  }, 30_000)

  it("⚠ does not draw a jersey match from another collection's edition row", async () => {
    // `editions.external_id` is unique per COLLECTION. The fixtures' Moments are
    // collection "c-1"; a row for "c-2" with the same external_id must not
    // decorate them.
    const p = payload(3)
    p.data.trophies[0].serial_number = 23 as never
    getPublicProfile.mockResolvedValue(p)

    jerseyRows = [{ external_id: "ed-0", collection_id: "c-2", jersey_number: 23 }]
    const wrongCollection = await render()

    jerseyRows = [{ external_id: "ed-0", collection_id: "c-1", jersey_number: 23 }]
    const rightCollection = await render()

    expect(wrongCollection.equals(rightCollection)).toBe(false)
  }, 30_000)
})
