// lib/trophy-case/pdf-image.ts
//
// Pure, dependency-light helpers extracted from the Trophy Case PDF route
// (app/api/profile/trophy-case/pdf/route.tsx). The route is a `route.tsx`, so
// it is measured by NEITHER coverage gate (the primary gate's include is
// app/api/**/route.**ts**); this module lands the route's pure logic — the
// color math, the thumbnail-URL normalizer, and the whole moment-art image
// pipeline (decode → background-strip/crop → downscale → re-encode) plus the
// special-serial classifier and text helpers — in lib/**, where it IS gated
// and unit-tested. The route imports these verbatim; behavior is unchanged.
//
// Everything here is I/O-free (no fetch, no Supabase) so it is fully testable
// in a node env. The image helpers depend only on pngjs/jpeg-js, which are
// node libraries importable by vitest.

import jpeg from "jpeg-js"
import { PNG } from "pngjs"

// brand-exception: PDF drawing can't resolve CSS vars — hex literals mirror
// app/rpc-tokens.css + the OG tier palette.
export const RPC_RED_HEX = "#E03A2F"
export const GOLD_HEX = "#F59E0B"
export const TIER_HEX_STR: Record<string, string> = {
  COMMON: "#9CA3AF",
  FANDOM: "#10B981",
  RARE: "#3B82F6",
  LEGENDARY: "#F59E0B",
  ULTIMATE: "#EF4444",
  CONTENDER: "#9CA3AF",
  CHALLENGER: "#3B82F6",
  UNCOMMON: "#10B981",
}

export const IPFS_GATEWAY_RE =
  /^https?:\/\/(?:ipfs\.io|ipfs\.dapperlabs\.com|cloudflare-ipfs\.com)\/ipfs\/([A-Za-z0-9]+)/

// Normalized [r,g,b] in 0..1 — the route wraps this with pdf-lib's rgb().
// Kept dependency-free (no pdf-lib import) so this module stays gate-testable.
export function hexToRgbTriplet(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ]
}

export function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "")
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}

export function tierHex(tier: string | null): string {
  return TIER_HEX_STR[(tier || "").toUpperCase()] ?? RPC_RED_HEX
}

// ───────────────────────── moment art pipeline ─────────────────────────

// Rewrite a thumbnail URL so its bytes are pdf-embeddable + print-quality:
// - format=webp/avif → format=jpeg (Dapper media APIs parameterize format)
// - width < 440 → width=440 (both assets.nbatopshot.com + media hosts honor it)
// - public IPFS gateways → same-origin edge-cached proxy
export function normalizeThumbUrl(url: string, baseUrl: string): string {
  // Same-origin relative paths (e.g. Pinnacle's /api/public/pinnacle-image/<key>)
  // must be absolutized for Node fetch.
  if (url.startsWith("/")) return `${baseUrl}${url}`
  const m = url.match(IPFS_GATEWAY_RE)
  if (m) return `${baseUrl}/api/public/ipfs-media/${m[1]}`
  try {
    const u = new URL(url)
    const fmt = u.searchParams.get("format")
    if (fmt && /^(webp|avif)$/i.test(fmt)) u.searchParams.set("format", "jpeg")
    const w = Number(u.searchParams.get("width"))
    if (Number.isFinite(w) && w > 0 && w < 440) u.searchParams.set("width", "440")
    return u.toString()
  } catch {
    return url
  }
}

export type Rgba = { width: number; height: number; data: Uint8Array }

export function decodeToRgba(bytes: Buffer): Rgba | null {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      const png = PNG.sync.read(bytes)
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      const out = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 128 })
      return { width: out.width, height: out.height, data: new Uint8Array(out.data) }
    }
  } catch {
    /* fall through */
  }
  return null
}

// Detect a uniform near-white or near-black background (sampled on the image
// border), flood-fill it to transparent from the borders (so same-colored
// pixels INSIDE the subject survive), then crop to the content bounding box.
// Returns the cropped RGBA (caller downscales + re-encodes), or null if no
// dominant background was found (caller embeds the original bytes untouched).
export function stripBackgroundAndCrop(img: Rgba): Rgba | null {
  const { width: w, height: h, data } = img
  const px = (x: number, y: number) => (y * w + x) * 4

  let whiteish = 0
  let blackish = 0
  let borderCount = 0
  const sample = (x: number, y: number) => {
    const i = px(x, y)
    const r = data[i], g = data[i + 1], b = data[i + 2]
    borderCount++
    if (r >= 218 && g >= 218 && b >= 218) whiteish++
    else if (r <= 45 && g <= 45 && b <= 45) blackish++
  }
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1) }
  for (let y = 1; y < h - 1; y++) { sample(0, y); sample(w - 1, y) }

  let mode: "white" | "black" | null = null
  if (whiteish / borderCount >= 0.6) mode = "white"
  else if (blackish / borderCount >= 0.6) mode = "black"
  if (!mode) return null

  const isBg =
    mode === "white"
      ? (i: number) => data[i] >= 210 && data[i + 1] >= 210 && data[i + 2] >= 210
      : (i: number) => data[i] <= 52 && data[i + 1] <= 52 && data[i + 2] <= 52

  // BFS flood fill from every border pixel that matches the background.
  const visited = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const idx = y * w + x
    if (!visited[idx] && isBg(idx * 4)) { visited[idx] = 1; stack.push(idx) }
  }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (stack.length > 0) {
    const idx = stack.pop() as number
    const x = idx % w, y = (idx / w) | 0
    data[idx * 4 + 3] = 0 // transparent
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }

  // Content bounding box over remaining opaque pixels.
  let minX = w, minY = h, maxX = -1, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[px(x, y) + 3] !== 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0 || maxX - minX < 8 || maxY - minY < 8) return null // degenerate

  const margin = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03)
  minX = Math.max(0, minX - margin)
  minY = Math.max(0, minY - margin)
  maxX = Math.min(w - 1, maxX + margin)
  maxY = Math.min(h - 1, maxY + margin)

  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  const out = new Uint8Array(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    const srcStart = px(minX, minY + y)
    out.set(data.subarray(srcStart, srcStart + cw * 4), y * cw * 4)
  }
  return { width: cw, height: ch, data: out }
}

// Box-average downscale to a max dimension — keeps huge source art (Golazos
// ships 2880×2880 heroes) from bloating the PDF after background-stripping.
export function downscaleRgba(img: Rgba, maxDim: number): Rgba {
  const { width: w, height: h, data } = img
  const scale = Math.min(1, maxDim / Math.max(w, h))
  if (scale >= 1) return img
  const ow = Math.max(1, Math.round(w * scale))
  const oh = Math.max(1, Math.round(h * scale))
  const out = new Uint8Array(ow * oh * 4)
  const fx = w / ow, fy = h / oh
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor(oy * fy), y1 = Math.min(h, Math.ceil((oy + 1) * fy))
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor(ox * fx), x1 = Math.min(w, Math.ceil((ox + 1) * fx))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * w + x0) * 4
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const al = data[i + 3]
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++
        }
      }
      const o = (oy * ow + ox) * 4
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round(a / n)
      }
    }
  }
  return { width: ow, height: oh, data: out }
}

export function encodePng(img: Rgba): Buffer {
  const png = new PNG({ width: img.width, height: img.height })
  png.data.set(img.data)
  return PNG.sync.write(png)
}

export function normBadgeKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

// Special-serial categories per the canonical definition (#1 / jersey /
// perfect). 1-of-1 renders the medal.
export type SpecialCat = "first" | "jersey" | "perfect"

export function specialCats(
  serial: number | null,
  circ: number | null,
  jersey: number | null,
): SpecialCat[] {
  if (!serial) return []
  const cats: SpecialCat[] = []
  if (serial === 1) cats.push("first")
  if (jersey != null && jersey > 0 && serial === jersey) cats.push("jersey")
  if (circ != null && circ > 1 && serial === circ) cats.push("perfect")
  return cats
}

// Structural font interface — the route passes a pdf-lib PDFFont, but only
// widthOfTextAtSize is needed, so tests can supply a fake measurer.
export interface TextMeasurer {
  widthOfTextAtSize(text: string, size: number): number
}

export function truncate(font: TextMeasurer, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text
  let t = text
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxWidth) t = t.slice(0, -1)
  return t + "…"
}

// Strip characters outside Latin-1 so neither WinAnsi (fallback fonts) nor the
// embedded subsets ever throw on emoji/unicode in player names or notes.
export function ansi(text: string): string {
  return text.replace(/[^\x20-\x7E -ÿ]/g, "").replace(/\s+/g, " ").trim()
}
