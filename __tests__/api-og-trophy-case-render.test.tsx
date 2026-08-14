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
vi.mock("@/lib/og/img-data", () => ({
  ogImageDataUri: vi.fn(async () => ART),
  ogImageDataUris: vi.fn(async (urls: string[]) => urls.map(() => ART)),
}))

const PNG_MAGIC = "89504e470d0a1a0a"

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
