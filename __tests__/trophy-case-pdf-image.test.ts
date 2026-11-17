import { describe, it, expect } from "vitest"
import { PNG } from "pngjs"
import {
  RPC_RED_HEX,
  GOLD_HEX,
  hexToRgbTriplet,
  hexToRgba,
  tierHex,
  normalizeThumbUrl,
  decodeToRgba,
  stripBackgroundAndCrop,
  downscaleRgba,
  encodePng,
  normBadgeKey,
  specialCats,
  truncate,
  ansi,
  type Rgba,
} from "@/lib/trophy-case/pdf-image"

const BASE = "https://www.rippackscity.com"

// Build a solid-color RGBA image.
function solid(w: number, h: number, r: number, g: number, b: number, a = 255): Rgba {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a
  }
  return { width: w, height: h, data }
}

// White field with an opaque black rectangle in the middle.
function whiteWithCenterBlock(w: number, h: number, bx0: number, by0: number, bx1: number, by1: number): Rgba {
  const img = solid(w, h, 255, 255, 255)
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = (y * w + x) * 4
      img.data[i] = 10; img.data[i + 1] = 10; img.data[i + 2] = 10; img.data[i + 3] = 255
    }
  }
  return img
}

describe("trophy-case pdf-image — color helpers", () => {
  it("hexToRgbTriplet normalizes 0..1 with and without #", () => {
    expect(hexToRgbTriplet("#ffffff")).toEqual([1, 1, 1])
    expect(hexToRgbTriplet("000000")).toEqual([0, 0, 0])
    const [r, g, b] = hexToRgbTriplet("#E03A2F")
    expect(r).toBeCloseTo(224 / 255, 5)
    expect(g).toBeCloseTo(58 / 255, 5)
    expect(b).toBeCloseTo(47 / 255, 5)
  })

  it("hexToRgba emits an rgba() string with the alpha", () => {
    expect(hexToRgba("#E03A2F", 0.35)).toBe("rgba(224,58,47,0.35)")
    expect(hexToRgba("10B981", 1)).toBe("rgba(16,185,129,1)")
  })

  it("tierHex maps known tiers, is case-insensitive, and falls back to RPC red", () => {
    expect(tierHex("LEGENDARY")).toBe("#F59E0B")
    expect(tierHex("legendary")).toBe("#F59E0B")
    expect(tierHex("CHALLENGER")).toBe("#3B82F6")
    expect(tierHex("nonsense")).toBe(RPC_RED_HEX)
    expect(tierHex(null)).toBe(RPC_RED_HEX)
    expect(tierHex("")).toBe(RPC_RED_HEX)
  })
})

describe("trophy-case pdf-image — normalizeThumbUrl", () => {
  it("absolutizes same-origin relative paths", () => {
    expect(normalizeThumbUrl("/api/public/pinnacle-image/abc", BASE)).toBe(`${BASE}/api/public/pinnacle-image/abc`)
  })

  it("rewrites public IPFS gateways to the same-origin proxy", () => {
    expect(normalizeThumbUrl("https://ipfs.io/ipfs/QmHash123", BASE)).toBe(`${BASE}/api/public/ipfs-media/QmHash123`)
    expect(normalizeThumbUrl("https://cloudflare-ipfs.com/ipfs/QmZ9", BASE)).toBe(`${BASE}/api/public/ipfs-media/QmZ9`)
  })

  it("swaps webp/avif format to jpeg", () => {
    expect(normalizeThumbUrl("https://media.host/x?format=webp", BASE)).toContain("format=jpeg")
    expect(normalizeThumbUrl("https://media.host/x?format=AVIF", BASE)).toContain("format=jpeg")
  })

  it("bumps sub-440 widths to 440 but leaves large widths alone", () => {
    expect(normalizeThumbUrl("https://media.host/x?width=200", BASE)).toContain("width=440")
    expect(normalizeThumbUrl("https://media.host/x?width=880", BASE)).toContain("width=880")
    // no width param → unchanged host
    expect(normalizeThumbUrl("https://media.host/x", BASE)).toBe("https://media.host/x")
  })

  it("returns the original string when the URL cannot be parsed", () => {
    expect(normalizeThumbUrl("not a url", BASE)).toBe("not a url")
  })
})

describe("trophy-case pdf-image — specialCats", () => {
  it("returns nothing for a null/zero serial", () => {
    expect(specialCats(null, 100, 23)).toEqual([])
    expect(specialCats(0, 100, 23)).toEqual([])
  })
  it("flags #1 as first", () => {
    expect(specialCats(1, 100, 23)).toEqual(["first"])
  })
  it("flags a jersey match only when jersey>0 and serial===jersey", () => {
    expect(specialCats(23, 100, 23)).toEqual(["jersey"])
    expect(specialCats(23, 100, 0)).toEqual([])
    expect(specialCats(23, 100, null)).toEqual([])
  })
  it("flags a perfect (serial===circ, circ>1) but not a 1-of-1 circ==1", () => {
    expect(specialCats(50, 50, null)).toEqual(["perfect"])
    expect(specialCats(1, 1, null)).toEqual(["first"]) // circ 1 excluded from perfect
  })
  it("can stack first+jersey+perfect", () => {
    // serial 1, jersey 1, circ 1 → first only (jersey needs serial===jersey=1 ok; perfect needs circ>1)
    expect(specialCats(1, 1, 1)).toEqual(["first", "jersey"])
    // serial 5 == jersey 5 == circ 5 → jersey + perfect
    expect(specialCats(5, 5, 5)).toEqual(["jersey", "perfect"])
  })
})

describe("trophy-case pdf-image — text helpers", () => {
  it("normBadgeKey slugifies and trims", () => {
    expect(normBadgeKey("Rookie Of The Year")).toBe("rookie-of-the-year")
    expect(normBadgeKey("  --3x3!!  ")).toBe("3x3")
    expect(normBadgeKey("MVP")).toBe("mvp")
  })

  it("ansi strips non-Latin, collapses space runs, trims", () => {
    // a run of spaces collapses to one; leading/trailing trimmed
    expect(ansi("  Zion   Williamson  ")).toBe("Zion Williamson")
    // a TAB is outside the allowed Latin-1 set, so it is stripped entirely
    // (not converted to a space) — tab-separated words join
    expect(ansi("Zion\tWilliamson")).toBe("ZionWilliamson")
    expect(ansi("emoji 🏀 tail")).toBe("emoji tail")
    expect(ansi("café")).toBe("café") // Latin-1 accented chars survive
  })

  it("truncate leaves fitting text alone and ellipsizes overflow", () => {
    // fake measurer: 1 unit per char
    const font = { widthOfTextAtSize: (t: string) => t.length }
    expect(truncate(font, "short", 10, 100)).toBe("short")
    // maxWidth 4: "longtext" (8) overflows → trim until t+"…" fits within 4 chars
    const out = truncate(font, "longtext", 10, 4)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(4)
  })
})

describe("trophy-case pdf-image — image pipeline", () => {
  it("decodeToRgba round-trips a PNG and rejects non-image bytes", () => {
    const png = new PNG({ width: 3, height: 2 })
    png.data.set(solid(3, 2, 12, 34, 56).data)
    const bytes = PNG.sync.write(png)
    const rgba = decodeToRgba(bytes)
    expect(rgba).not.toBeNull()
    expect(rgba!.width).toBe(3)
    expect(rgba!.height).toBe(2)
    expect(decodeToRgba(Buffer.from([1, 2, 3, 4]))).toBeNull()
    // JPEG magic on truncated bytes → decode throws internally → null
    expect(decodeToRgba(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBeNull()
  })

  it("encodePng produces bytes decodeToRgba can read back", () => {
    const img = solid(4, 4, 200, 100, 50)
    const bytes = encodePng(img)
    const back = decodeToRgba(bytes)
    expect(back?.width).toBe(4)
    expect(back?.height).toBe(4)
  })

  it("stripBackgroundAndCrop crops a white field to its content block", () => {
    const img = whiteWithCenterBlock(40, 40, 12, 12, 27, 27)
    const cropped = stripBackgroundAndCrop(img)
    expect(cropped).not.toBeNull()
    // content is 16x16; with a 3% margin the crop is a bit larger but far smaller than 40x40
    expect(cropped!.width).toBeLessThan(40)
    expect(cropped!.height).toBeLessThan(40)
    expect(cropped!.width).toBeGreaterThanOrEqual(16)
  })

  it("stripBackgroundAndCrop returns null when there is no dominant background", () => {
    // a mid-gray field: neither whiteish (>=218) nor blackish (<=45) on the border
    expect(stripBackgroundAndCrop(solid(20, 20, 120, 120, 120))).toBeNull()
  })

  it("stripBackgroundAndCrop returns null for a degenerate (all-background) image", () => {
    // pure white with no content → after flood fill nothing opaque remains
    expect(stripBackgroundAndCrop(solid(20, 20, 255, 255, 255))).toBeNull()
  })

  it("downscaleRgba shrinks to the max dimension and passes small images through", () => {
    const big = solid(100, 50, 30, 30, 30)
    const small = downscaleRgba(big, 40)
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(40)
    expect(small.width).toBe(40)
    expect(small.height).toBe(20)
    // already within bound → returned unchanged (same object)
    const tiny = solid(10, 10, 1, 2, 3)
    expect(downscaleRgba(tiny, 40)).toBe(tiny)
  })
})

describe("trophy-case pdf-image — brand constants", () => {
  it("exposes the RPC brand hexes used by the PDF drawing layer", () => {
    expect(RPC_RED_HEX).toBe("#E03A2F")
    expect(GOLD_HEX).toBe("#F59E0B")
  })
})
