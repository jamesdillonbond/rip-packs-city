import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins lib/og/img-data.ts — the resilient OG-card image prefetcher. Covers the
// input guards (null / non-http / data:), the IPFS gateway → /api/public/
// ipfs-media/<cid> proxy rewrite, content-type/magic-byte format gating
// (WebP/AVIF dropped, PNG/JPEG/GIF/SVG accepted, octet-stream sniffed), the
// per-image byte cap and empty-buffer/!ok/timeout(reject) → null degradation,
// data-URI assembly, and ogImageDataUris' order-preserving failure drop + the
// ~10MB total-payload budget. global fetch is stubbed to return controlled
// bytes + content-type so every branch is deterministic.

import { ogImageDataUri, ogImageDataUris } from "@/lib/og/img-data"

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

  it("returns null for non-http(s) urls (e.g. ipfs://, relative)", async () => {
    expect(await ogImageDataUri("ipfs://Qm123")).toBeNull()
    expect(await ogImageDataUri("/local/path.png")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("ogImageDataUri — IPFS gateway rewrite", () => {
  it("rewrites a public IPFS gateway url to the edge-cached proxy", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    await ogImageDataUri("https://ipfs.dapperlabs.com/ipfs/QmABC123")
    const target = fetchMock.mock.calls[0][0]
    expect(target).toBe("https://www.rippackscity.com/api/public/ipfs-media/QmABC123")
  })

  it("leaves a non-IPFS url untouched", async () => {
    fetchMock.mockResolvedValue(res(PNG_BYTES, "image/png"))
    await ogImageDataUri("https://assets.nbatopshot.com/foo.png")
    expect(fetchMock.mock.calls[0][0]).toBe("https://assets.nbatopshot.com/foo.png")
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
