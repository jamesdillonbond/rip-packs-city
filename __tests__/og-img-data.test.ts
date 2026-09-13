import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins lib/og/img-data.ts — the resilient OG-card image prefetcher. Covers the
// input guards (null / non-http / data:), the IPFS gateway → /api/public/
// ipfs-media/<cid> proxy rewrite, content-type/magic-byte format gating
// (WebP/AVIF dropped, PNG/JPEG/GIF/SVG accepted, octet-stream sniffed), the
// per-image byte cap and empty-buffer/!ok/timeout(reject) → null degradation,
// data-URI assembly, and ogImageDataUris' order-preserving failure drop + the
// ~10MB total-payload budget. global fetch is stubbed to return controlled
// bytes + content-type so every branch is deterministic.

import { readFileSync } from "node:fs"
import path from "node:path"

// ⚠ THE INSTALLED NEXT'S OWN DEFAULTS, imported rather than restated. The
// optimizer url below is only valid against these; a version bump that moves
// `qualities`, `deviceSizes` or `formats` must red these cases, not pass them.
import { imageConfigDefault } from "next/dist/shared/lib/image-config"

import {
  OG_OPTIMIZER_HOSTS,
  ogImageDataUri,
  ogImageDataUris,
  ogImageDataUriSlots,
  ogImageTarget,
  ogOptimizedTarget,
} from "@/lib/og/img-data"

const fetchMock = vi.fn()

// Builds a Response-ish object with a real ArrayBuffer body.
function res(bytes: number[] | Uint8Array, contentType: string | null, init?: { ok?: boolean; status?: number }) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: { get: (_k: string) => contentType },
    arrayBuffer: async () => arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength),
  }
}

// ⚠ EVERY "which url did we fetch" ASSERTION BELOW GOES THROUGH
// `effectiveTarget`. Since 2026-09-12 art that no origin will size for us is
// fetched through our own `/_next/image`, so the raw target moved from the
// fetch url into its `url=` parameter. Unwrapping it keeps each case pinning
// the property it is NAMED for (the IPFS proxy rewrite, the site-relative
// resolve) instead of accidentally pinning whether the optimizer leg exists.
function effectiveTarget(u: unknown): string {
  const s = String(u)
  const m = /^https:\/\/www\.rippackscity\.com\/_next\/image\?url=([^&]+)/.exec(s)
  if (!m) return s
  const inner = decodeURIComponent(m[1])
  return inner.startsWith("/") ? `https://www.rippackscity.com${inner}` : inner
}

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ogImageDataUri — input guards", () => {
  it("returns null for null/undefined/empty", async () => {
    expect(await ogImageDataUri(null)).toBeNull()
    expect(await ogImageDataUri(undefined)).toBeNull()
    expect(await ogImageDataUri("")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("passes a data: URI straight through without fetching", async () => {
    const dataUri = "data:image/png;base64,AAAA"
    expect(await ogImageDataUri(dataUri)).toBe(dataUri)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns null for a url with no scheme we can fetch", async () => {
    expect(await ogImageDataUri("ipfs://Qm123")).toBeNull()
    expect(await ogImageDataUri("not a url")).toBeNull()
    // ⚠ Protocol-relative, NOT site-relative. Prefixing BASE_URL here would
    // build https://www.rippackscity.com//assets.example.com/a.png.
    expect(await ogImageDataUri("//assets.example.com/a.png")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ⚠ INVERTED 2026-09-12, deliberately. This case used to assert that a
  // SITE-RELATIVE url resolved to null with no fetch, which is exactly the
  // behaviour that meant no Disney Pinnacle art has ever rendered on any OG
  // card — Pinnacle addresses ALL of its art as
  // `/api/public/pinnacle-image/<render_id>` because Dapper's CDN serves only
  // signed, short-lived URLs. The old assertion was pinning the defect in
  // place, so it states the opposite property now rather than being deleted.
  it("resolves a SITE-RELATIVE path against our own origin and fetches it", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    const out = await ogImageDataUri("/api/public/pinnacle-image/LEV2-LION-CARE-S6")
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`)
    // ⚠ Asserted by MEMBERSHIP, not by call INDEX. A Pinnacle path is now
    // preceded by a `pinnacle_render_cache` lookup (see below), and pinning
    // this to `calls[0]` pinned the ORDER of an unrelated read rather than the
    // property this case is named for — which is that a site-relative path
    // resolves against our own origin at all.
    expect(fetchMock.mock.calls.map((c) => effectiveTarget(c[0]))).toContain(
      "https://www.rippackscity.com/api/public/pinnacle-image/LEV2-LION-CARE-S6",
    )
  })
})

describe("Pinnacle art prefers the OPTIMIZER, then the render cache, then the 2.9MB live render", () => {
  // ⭐ `/api/public/pinnacle-image/<id>` 302s to a FULL-RESOLUTION Dapper
  // render — LEV2-LION-CARE-S6 measured 2,896,041 B at 2880×2880 on
  // 2026-09-12, against this module's own 4MB cap. `pinnacle_render_cache`
  // holds the same render downscaled to 316,140 B (re-read live 2026-09-13).
  //
  // 🚨 THIS BLOCK WAS INVERTED ON 2026-09-13, NOT DELETED, AND THE REASON IS
  // THE WHOLE POINT. Its first test used to assert the cache is consulted FIRST
  // and "never touches the live route" — correct when written, hours before the
  // optimizer leg existed. The optimizer returns **61,788 B** for this render,
  // so cache-first was shipping **5.1× MORE bytes** than doing nothing. A test
  // that pins an ordering keeps that ordering alive long after the measurement
  // under it has moved, so the assertion is now the OPPOSITE one and the old
  // claim survives only as this comment. (register #90)
  const CACHE_RE = /rest\/v1\/pinnacle_render_cache/
  const OPTIMIZER_RE = /\/_next\/image\?/

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key")
  })

  it("🚨 THE OPTIMIZER WINS OVER THE CACHE — the cache is not even consulted on an optimizer hit", async () => {
    // The inverted assertion. A cache hit is available here and must NOT be
    // taken: at 316,140 B it is 5.1× the optimizer's 61,788 B for the same art.
    const b64 = Buffer.from(new Uint8Array(PNG_BYTES)).toString("base64")
    fetchMock.mockImplementation(async (url: string) => {
      if (OPTIMIZER_RE.test(String(url))) return res(PNG_BYTES, "image/png")
      if (CACHE_RE.test(String(url))) {
        throw new Error("the render cache must not be read when the optimizer answers")
      }
      throw new Error("live Pinnacle route must not be fetched when the optimizer answers")
    })
    const out = await ogImageDataUri("/api/public/pinnacle-image/LEV2-LION-CARE-S6")
    expect(out).toBe(`data:image/png;base64,${b64}`)
    expect(fetchMock.mock.calls.some((c) => OPTIMIZER_RE.test(String(c[0])))).toBe(true)
    expect(fetchMock.mock.calls.some((c) => CACHE_RE.test(String(c[0])))).toBe(false)
  })

  it("⭐ the cache is the SECOND choice — taken when the optimizer refuses, ahead of the 2.9MB direct fetch", async () => {
    // The half of the cache's justification that SURVIVED the optimizer landing:
    // when the optimizer cannot serve the art, 316 KB still beats a 2.9 MB direct
    // fetch that may not even clear the 4 MB cap. Moving the read was a demotion,
    // not a removal, and this is the case that says so.
    const b64 = Buffer.from(new Uint8Array(PNG_BYTES)).toString("base64")
    fetchMock.mockImplementation(async (url: string) => {
      if (OPTIMIZER_RE.test(String(url))) return { ok: false, status: 400, headers: { get: () => null } }
      if (CACHE_RE.test(String(url))) {
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => [{ mime: "image/png", b64 }] }
      }
      throw new Error("the direct 2.9MB render must not be fetched when the cache can answer")
    })
    const out = await ogImageDataUri("/api/public/pinnacle-image/LEV2-LION-CARE-S6")
    expect(out).toBe(`data:image/png;base64,${b64}`)
    expect(fetchMock.mock.calls.some((c) => CACHE_RE.test(String(c[0])))).toBe(true)
  })

  it("⭐ with `optimize: false` the cache is FIRST again — 316KB still beats 2.9MB", async () => {
    // The ordering has to be right in both worlds. With no optimizer leg the
    // cache is the cheapest source available, and skipping it would hand satori
    // the full-resolution render for no reason.
    const b64 = Buffer.from(new Uint8Array(PNG_BYTES)).toString("base64")
    fetchMock.mockImplementation(async (url: string) => {
      if (CACHE_RE.test(String(url))) {
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => [{ mime: "image/png", b64 }] }
      }
      throw new Error("live Pinnacle route must not be fetched when the cache hits")
    })
    const out = await ogImageDataUri("/api/public/pinnacle-image/LEV2-LION-CARE-S6", { optimize: false })
    expect(out).toBe(`data:image/png;base64,${b64}`)
    expect(fetchMock.mock.calls.every((c) => CACHE_RE.test(String(c[0])))).toBe(true)
  })

  it("falls back to the live render on a cache MISS — the cache holds one row", async () => {
    // ⚠ Stated rather than designed around: this is a proven mechanism, not a
    // populated cache. It works for Simba and for nothing else today, so the
    // live route stays the fallback rather than being demoted to a last resort.
    fetchMock.mockImplementation(async (url: string) => {
      if (CACHE_RE.test(String(url))) {
        return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => [] }
      }
      return res(PNG_BYTES, "image/png")
    })
    const out = await ogImageDataUri("/api/public/pinnacle-image/OEV1-SOUL-JGAR-S2")
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`)
    expect(fetchMock.mock.calls.map((c) => effectiveTarget(c[0]))).toContain(
      "https://www.rippackscity.com/api/public/pinnacle-image/OEV1-SOUL-JGAR-S2",
    )
  })

  it("⚠ VALIDATES THE BYTES rather than trusting the row's `mime`", async () => {
    // The column is written by a home-machine script posting through an admin
    // route. A truncated or HTML-bodied row labelled image/png would otherwise
    // be handed to satori and take the whole card down — the exact failure this
    // module exists to prevent. A bad row must degrade to the live render.
    fetchMock.mockImplementation(async (url: string) => {
      if (CACHE_RE.test(String(url))) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => [{ mime: "image/png", b64: Buffer.from("<!doctype html><html>").toString("base64") }],
        }
      }
      return res(PNG_BYTES, "image/png")
    })
    const out = await ogImageDataUri("/api/public/pinnacle-image/LEV2-LION-CARE-S6")
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`)
  })

  it("does not consult the cache for art that is not a Pinnacle render", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    await ogImageDataUri("https://assets.nbatopshot.com/media/49744949/image?width=180")
    expect(fetchMock.mock.calls.some((c) => CACHE_RE.test(String(c[0])))).toBe(false)
  })
})

describe("ogImageTarget — the two url shapes that dropped whole collections", () => {
  it("absolutizes a site-relative Pinnacle art path", () => {
    expect(ogImageTarget("/api/public/pinnacle-image/LEV2-LION-CARE-S6")).toBe(
      "https://www.rippackscity.com/api/public/pinnacle-image/LEV2-LION-CARE-S6",
    )
  })

  it("asks an All Day render url for PNG instead of the WebP satori cannot decode", () => {
    // The live shape, verified against the DB 2026-09-12: all 6,190 nfl_all_day
    // editions carry format=webp, and the same origin serves format=png.
    expect(
      ogImageTarget("https://media.nflallday.com/editions/675/media/image?width=512&format=webp&quality=90"),
    ).toBe("https://media.nflallday.com/editions/675/media/image?width=512&format=png&quality=90")
  })

  it("rewrites format=avif too, and leaves a format we can decode alone", () => {
    expect(ogImageTarget("https://ex.com/a?format=avif")).toBe("https://ex.com/a?format=png")
    expect(ogImageTarget("https://ex.com/a?format=jpeg")).toBe("https://ex.com/a?format=jpeg")
  })

  it("does not maul a url whose path merely contains the word webp", () => {
    expect(ogImageTarget("https://ex.com/webp/a.png")).toBe("https://ex.com/webp/a.png")
    expect(ogImageTarget("https://ex.com/a.webp")).toBe("https://ex.com/a.webp")
    // ...nor a longer value that merely starts with it.
    expect(ogImageTarget("https://ex.com/a?format=webpx")).toBe("https://ex.com/a?format=webpx")
  })

  it("still prefers the IPFS proxy over any format rewrite", () => {
    expect(ogImageTarget("https://ipfs.io/ipfs/QmABC?format=webp")).toBe(
      "https://www.rippackscity.com/api/public/ipfs-media/QmABC",
    )
  })
})

describe("ogImageDataUri — IPFS gateway rewrite", () => {
  it("rewrites a public IPFS gateway url to the edge-cached proxy", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    await ogImageDataUri("https://ipfs.dapperlabs.com/ipfs/QmABC123")
    const target = effectiveTarget(fetchMock.mock.calls[0][0])
    expect(target).toBe("https://www.rippackscity.com/api/public/ipfs-media/QmABC123")
  })

  it("leaves a non-IPFS url untouched", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    await ogImageDataUri("https://assets.nbatopshot.com/foo.png")
    expect(effectiveTarget(fetchMock.mock.calls[0][0])).toBe("https://assets.nbatopshot.com/foo.png")
  })
})

describe("ogImageDataUri — format gating & data-URI assembly", () => {
  it("PNG with a good content-type → data:image/png base64", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    const out = await ogImageDataUri("https://ex.com/a.png")
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`)
  })

  it("strips content-type parameters (image/jpeg; charset=…) to the bare type", async () => {
    fetchMock.mockResolvedValue(res(JPEG_BYTES, "image/jpeg; charset=binary"))
    const out = await ogImageDataUri("https://ex.com/a.jpg")
    expect(out).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`)
  })

  it("octet-stream content-type falls back to magic-byte sniff (PNG)", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "application/octet-stream"))
    const out = await ogImageDataUri("https://ex.com/a.bin")
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`)
  })

  it("missing content-type header still sniffs successfully", async () => {
    fetchMock.mockResolvedValue(res(JPEG_BYTES, null))
    const out = await ogImageDataUri("https://ex.com/a")
    expect(out).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`)
  })

  it("GIF magic bytes are sniffed from octet-stream", async () => {
    const gif = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 1, 2, 3]
    fetchMock.mockResolvedValue(res(gif, "application/octet-stream"))
    const out = await ogImageDataUri("https://ex.com/a.gif")
    expect(out).toBe(`data:image/gif;base64,${Buffer.from(gif).toString("base64")}`)
  })

  it("SVG (<svg / <?xml prefix) is sniffed from octet-stream", async () => {
    const svg = Array.from(Buffer.from('<svg xmlns="http://x"></svg>'))
    fetchMock.mockResolvedValue(res(svg, "application/octet-stream"))
    const out = await ogImageDataUri("https://ex.com/a.svg")
    expect(out).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
  })

  it("a too-short (< 12 byte) unrecognized buffer → null via the sniff guard", async () => {
    fetchMock.mockResolvedValue(res([1, 2, 3, 4], "application/octet-stream"))
    expect(await ogImageDataUri("https://ex.com/tiny.bin")).toBeNull()
  })

  it("WebP is dropped (not in OK_TYPES and unsniffable) → null", async () => {
    fetchMock.mockResolvedValue(res(WEBP_BYTES, "image/webp"))
    expect(await ogImageDataUri("https://ex.com/a.webp")).toBeNull()
  })

  it("AVIF is dropped → null", async () => {
    fetchMock.mockResolvedValue(res([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 1, 2], "image/avif"))
    expect(await ogImageDataUri("https://ex.com/a.avif")).toBeNull()
  })
})

describe("ogImageDataUri — size / status / error degradation", () => {
  it("oversize buffer (> maxBytes) → null", async () => {
    const big = new Uint8Array(200)
    big.set(PNG_BYTES)
    fetchMock.mockResolvedValue(res(big, "image/png"))
    expect(await ogImageDataUri("https://ex.com/big.png", { maxBytes: 100 })).toBeNull()
  })

  it("empty buffer → null", async () => {
    fetchMock.mockResolvedValue(res([], "image/png"))
    expect(await ogImageDataUri("https://ex.com/empty.png")).toBeNull()
  })

  it("non-ok response → null", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png", { ok: false, status: 404 }))
    expect(await ogImageDataUri("https://ex.com/missing.png")).toBeNull()
  })

  it("fetch rejecting (timeout/abort/network) → null", async () => {
    fetchMock.mockRejectedValue(new Error("aborted"))
    expect(await ogImageDataUri("https://ex.com/slow.png")).toBeNull()
  })
})

describe("ogImageDataUris — batch prefetch", () => {
  it("preserves order and drops failures (null results)", async () => {
    fetchMock
      .mockResolvedValueOnce(res(PNG_BYTES, "image/png"))
      .mockResolvedValueOnce(res(WEBP_BYTES, "image/webp")) // dropped
      .mockResolvedValueOnce(res(JPEG_BYTES, "image/jpeg"))
    const out = await ogImageDataUris([
      "https://ex.com/1.png",
      "https://ex.com/2.webp",
      "https://ex.com/3.jpg",
    ])
    expect(out).toEqual([
      `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`,
      `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`,
    ])
  })

  it("skips null/guarded inputs without fetching them", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    const out = await ogImageDataUris([null, "https://ex.com/a.png", "ipfs://x"])
    expect(out).toHaveLength(1)
    // only the one valid http url triggers a fetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("enforces the ~10MB total-payload budget, dropping images past it", async () => {
    // Two ~3.9MB PNGs: each base64-expands to ~5.2MB of data-URI chars, so the
    // second pushes past the 10MB budget and is dropped even though both are
    // individually under the 4MB per-image cap.
    const mk = () => {
      const b = new Uint8Array(3.9 * 1024 * 1024)
      b.set(PNG_BYTES)
      return res(b, "image/png")
    }
    fetchMock.mockResolvedValueOnce(mk()).mockResolvedValueOnce(mk())
    const out = await ogImageDataUris(["https://ex.com/1.png", "https://ex.com/2.png"])
    expect(out).toHaveLength(1)
  })
})

describe("ogImageDataUriSlots — position is the contract", () => {
  it("leaves a null IN PLACE where an image failed, rather than closing the gap", async () => {
    // ⚠ THE DEFECT THIS EXISTS TO PREVENT. `ogImageDataUris` compacts, so a
    // caller reading `uris[i]` beside `rows[i]` captions image 3 with name 2.
    // The trophy-case card did exactly that and shipped Kevin Durant's Moment
    // under "Amon-Ra St. Brown" (2026-09-12).
    fetchMock
      .mockResolvedValueOnce(res(PNG_BYTES, "image/png"))
      .mockResolvedValueOnce(res(WEBP_BYTES, "image/webp")) // undecodable -> null
      .mockResolvedValueOnce(res(JPEG_BYTES, "image/jpeg"))
    const out = await ogImageDataUriSlots([
      "https://ex.com/1.png",
      "https://ex.com/2.bin",
      "https://ex.com/3.jpg",
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`)
    expect(out[1]).toBeNull()
    expect(out[2]).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`)
  })

  it("keeps a slot for an input that was never fetchable at all", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    const out = await ogImageDataUriSlots([null, "https://ex.com/a.png", "ipfs://x"])
    expect(out).toHaveLength(3)
    expect(out[0]).toBeNull()
    expect(out[1]).not.toBeNull()
    expect(out[2]).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("nulls an image that busts the total-payload budget without shifting the rest", async () => {
    const big = () => {
      const b = new Uint8Array(3.9 * 1024 * 1024)
      b.set(PNG_BYTES)
      return res(b, "image/png")
    }
    fetchMock
      .mockResolvedValueOnce(big())
      .mockResolvedValueOnce(big())
      .mockResolvedValueOnce(res(JPEG_BYTES, "image/jpeg"))
    const out = await ogImageDataUriSlots([
      "https://ex.com/1.png",
      "https://ex.com/2.png",
      "https://ex.com/3.jpg",
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).not.toBeNull()
    expect(out[1]).toBeNull() // over budget
    expect(out[2]).not.toBeNull() // small enough to still fit, and still at index 2
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE `/_next/image` LEG (2026-09-12)
//
// ⭐ THE DEFECT THESE PIN: the 4MB cap below was perfectly correlated with how
// valuable the Moment is. Dapper's art gets richer as the tier rises, so six
// random `/editions/` files per tier measured ULTIMATE 6/6 over the cap (median
// 6.73 MB) and COMMON 0/6 (median 3.21 MB) — edition 220:8093 (ULTIMATE,
// $1,350) published a blank grey placeholder while 133:4738 (COMMON, $0.39)
// published full art. The cap is correct; 2880×2880 art in a 550px slot is not.
// ─────────────────────────────────────────────────────────────────────────────

// The real shape, from the live DB: 8,405 of the 8,405 Top Shot rows on this
// path are 2880×2880 statics with no size control of any kind.
const ULTIMATE_ART =
  "https://assets.nbatopshot.com/editions/8_wnba_base_set_common/b4284ee2-dfd6-4547-9ecd-d42d7b6382bc/play_b4284ee2_capture_Hero_2880_2880_Transparent.png"
const OPTIMIZER_PREFIX = "https://www.rippackscity.com/_next/image"

function oversized(): Uint8Array {
  const b = new Uint8Array(5 * 1024 * 1024)
  b.set(PNG_BYTES)
  return b
}

describe("ogOptimizedTarget — which art is worth a transformation", () => {
  it("wraps a 2880px static edition render", () => {
    const out = ogOptimizedTarget(ULTIMATE_ART)
    expect(out).toBe(
      `${OPTIMIZER_PREFIX}?url=${encodeURIComponent(ULTIMATE_ART)}&w=640&q=75`,
    )
  })

  it("hands OUR OWN urls over as a LOCAL PATH, never as an absolute url", () => {
    // The optimizer checks an absolute url against `remotePatterns` — where our
    // own domain does not appear and must never be added, because that makes us
    // an open image proxy for ourselves. A relative url goes to `localPatterns`,
    // which is undefined and therefore allows everything local.
    const out = ogOptimizedTarget("https://www.rippackscity.com/api/public/ipfs-media/QmABC")
    expect(out).toBe(`${OPTIMIZER_PREFIX}?url=%2Fapi%2Fpublic%2Fipfs-media%2FQmABC&w=640&q=75`)
    const inner = decodeURIComponent(/url=([^&]+)/.exec(out!)![1])
    expect(inner.startsWith("/")).toBe(true)
    expect(inner).not.toContain("rippackscity.com")
  })

  it("skips a render endpoint whose origin has ALREADY sized the art", () => {
    // Measured 2026-09-12: 31,507 B and 45,121 B respectively. Optimizing these
    // buys nothing and would UPSCALE them — sharp enlarges by default.
    expect(ogOptimizedTarget("https://assets.nbatopshot.com/media/51976956/image?width=400")).toBeNull()
    expect(
      ogOptimizedTarget("https://media.nflallday.com/editions/2835/media/image?width=512&format=png&quality=90"),
    ).toBeNull()
  })

  it("⚠ does NOT read hiResThumb's ?width= on a STATIC file as 'already sized'", () => {
    // `hiResThumb` (lib/trophy/slab-style.ts) appends `?width=640` to EVERY
    // assets.nbatopshot.com url, the 2880×2880 statics included, where the
    // origin serves the same master whatever you ask for. Treating a width
    // param as proof of sizing would have re-opened this defect on the two
    // trophy cards — the exact surface the blank Ultimates were found on.
    const withWidth = `${ULTIMATE_ART}?width=640`
    expect(ogOptimizedTarget(withWidth)).toBe(
      `${OPTIMIZER_PREFIX}?url=${encodeURIComponent(withWidth)}&w=640&q=75`,
    )
  })

  it("skips a url that is not parseable at all rather than throwing at a card", () => {
    // ogImageTarget gates on ^https?:// before this runs, so this is a guard
    // against a future caller, not a live shape — but a throw here would 500
    // the whole card, which is the one thing this module exists to prevent.
    expect(ogOptimizedTarget("https://exa mple.com/a.png")).toBeNull()
  })

  it("skips a host next.config.ts does not admit, rather than buying a 400", () => {
    // Candy MLB art (125 rows) and 16 legacy Top Shot rows. Not a defect: they
    // take the direct fetch, which is what they do today.
    expect(ogOptimizedTarget("https://arweave.net/iKT2pAHeP1QA1jZn")).toBeNull()
    expect(ogOptimizedTarget("https://storage.googleapis.com/content-pipeline/x.png")).toBeNull()
  })
})

describe("the optimizer url is DERIVED from the installed next config, not remembered", () => {
  // ⚠ A `w` outside deviceSizes ∪ imageSizes or a `q` outside `qualities` is a
  // 400, and a 400 is invisible here — it degrades to the direct fetch and the
  // Ultimates go back to publishing blank. Reading the defaults off the
  // installed Next means a version bump that moves them reds this instead.
  const url = new URL(ogOptimizedTarget(ULTIMATE_ART)!)

  it("w is an allowed size", () => {
    const sizes = [...imageConfigDefault.deviceSizes, ...imageConfigDefault.imageSizes]
    expect(sizes).toContain(Number(url.searchParams.get("w")))
  })

  it("q is an allowed quality", () => {
    expect(imageConfigDefault.qualities).toContain(Number(url.searchParams.get("q")))
  })

  it("w still covers the largest slot any card draws (the moment card's 550px pane)", () => {
    expect(Number(url.searchParams.get("w"))).toBeGreaterThanOrEqual(550)
  })

  it("every OG_OPTIMIZER_HOSTS entry is in next.config.ts remotePatterns", () => {
    const cfg = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8")
    const admitted = new Set(
      Array.from(cfg.matchAll(/hostname:\s*"([^"]+)"/g)).map((m) => m[1]),
    )
    expect(OG_OPTIMIZER_HOSTS.length).toBeGreaterThan(0)
    for (const h of OG_OPTIMIZER_HOSTS) expect(admitted).toContain(h)
  })
})

describe("ogImageDataUri — the optimizer leg can only ADD art, never remove it", () => {
  it("⭐ RENDERS ART THE CAP WAS DROPPING: oversized upstream, optimized derivative", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      String(u).startsWith(OPTIMIZER_PREFIX) ? res(PNG_BYTES, "image/png") : res(oversized(), "image/png"),
    )
    const out = await ogImageDataUri(ULTIMATE_ART)
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`)
  })

  it("NO-CHANGE CONTROL: the same art with the leg off is still the blank card", async () => {
    // The cap is untouched. This is the behaviour every Ultimate got until
    // 2026-09-12, reproduced deliberately so the case above is measuring the
    // optimizer rather than a mock that would have passed either way.
    fetchMock.mockResolvedValue(res(oversized(), "image/png"))
    expect(await ogImageDataUri(ULTIMATE_ART, { optimize: false })).toBeNull()
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).startsWith(OPTIMIZER_PREFIX))).toBe(true)
  })

  it("falls back to the direct fetch when the optimizer refuses it", async () => {
    // A remotePatterns drift, an input sharp will not touch, a platform
    // difference. Art that renders today must keep rendering.
    fetchMock.mockImplementation(async (u: string) =>
      String(u).startsWith(OPTIMIZER_PREFIX)
        ? res(PNG_BYTES, "image/png", { ok: false, status: 400 })
        : res(JPEG_BYTES, "image/jpeg"),
    )
    const out = await ogImageDataUri(ULTIMATE_ART)
    expect(out).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString("base64")}`)
  })

  it("⛔ never names webp or avif in Accept — that is what keeps the PNG a PNG", async () => {
    // next/dist/server/image-optimizer.js:222 returns a negotiated format ONLY
    // when `accept.includes(it)`; `images.formats` is ["image/webp"], and
    // "image/*" does not contain that literal, so the optimizer converts
    // nothing and a PNG upstream comes back PNG. Naming webp here would hand
    // satori the one format it cannot decode — every card would go blank.
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    await ogImageDataUri(ULTIMATE_ART)
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    const accept = init.headers.Accept
    expect(accept).toBe("image/*")
    // Next's own predicate, re-run against the installed config rather than
    // restated: a format is negotiated only if the Accept header CONTAINS its
    // literal. Asserting the ABSENCE of a conversion is the property; asserting
    // that the header merely lacks the word "webp" would keep passing if
    // `images.formats` ever gained a type our Accept does spell out.
    expect(imageConfigDefault.formats.filter((f) => accept.includes(f))).toEqual([])
  })

  it("spends ONE budget across both legs, not one each", async () => {
    // A card's art budget is what a crawler will wait. A dead upstream must not
    // cost double just because we asked two ways, so a fallback that cannot
    // finish inside what is LEFT is not started.
    fetchMock.mockResolvedValue(res(WEBP_BYTES, "image/webp")) // undecodable -> null
    expect(await ogImageDataUri(ULTIMATE_ART, { timeoutMs: 100 })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("asks ONCE for art an origin already sized", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    await ogImageDataUri("https://media.nflallday.com/editions/2835/media/image?width=512&format=webp")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/_next/image")
  })
})

