// app/api/profile/trophy-case/pdf/route.tsx
//
// Exportable Trophy Case — renders a collector's 6-slot trophy case as a
// branded, downloadable PDF (landscape Letter, dark theme, 3×2 slab grid).
// Data comes from the same public SECDEF RPC the on-page trophy case uses
// (get_trophy_slab_data_by_username), so anything visible on /profile/<u>
// is exactly what exports — nothing more. Deliberately NO FMV / valuation:
// this is a show-off card, not an account statement (Trevor, 2026-07-07).
//
//   GET /api/profile/trophy-case/pdf?username=<u>   → application/pdf download
//
// Anon-public via the proxy.ts carve-out (same rationale as
// /api/profile/trophy-slabs — the profile trophy case is already public).
//
// v6 visual system (Trevor, 2026-07-13):
// - Brand typography: Barlow Condensed Black + Share Tech Mono (OFL, vendored
//   under public/fonts, embedded subset via @pdf-lib/fontkit) — no Helvetica.
// - "Holo slab" panels: satori-rendered per-tier backgrounds (dark gradient,
//   tier-colored glow, art shadow well) instead of flat rectangles.
// - Serial is the hero stat (#38 / 49, large); special serials render GOLD,
//   and true 1-of-1s get a full gold slab.
// - Footer QR code deep-links to rippackscity.com/profile/<u>.
//
// Art pipeline (v3+): moment art is decoded (jpeg-js/pngjs), its uniform
// white/black background flood-filled to transparency from the borders, and
// cropped to content so it floats on the slab. Badge icons are the REAL
// per-collection art (TS momentTags SVGs / AllDay badgesV3 SVGs via our
// /api/badge-image allowlist proxy), satori-rasterized to PNG; RPC-brand
// glyphs remain only as soft-fail fallback. Special serials use gold RPC
// glyphs (medal #1 / jersey / perfect target).

import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { supabase as supabaseAnon } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";
const IPFS_GATEWAY_RE =
  /^https?:\/\/(?:ipfs\.io|ipfs\.dapperlabs\.com|cloudflare-ipfs\.com)\/ipfs\/([A-Za-z0-9]+)/;

// brand-exception: PDF drawing can't resolve CSS vars — hex literals mirror
// app/rpc-tokens.css + the OG tier palette.
const RPC_RED_HEX = "#E03A2F";
const GOLD_HEX = "#F59E0B";
const TIER_HEX_STR: Record<string, string> = {
  COMMON: "#9CA3AF",
  FANDOM: "#10B981",
  RARE: "#3B82F6",
  LEGENDARY: "#F59E0B",
  ULTIMATE: "#EF4444",
  CONTENDER: "#9CA3AF",
  CHALLENGER: "#3B82F6",
  UNCOMMON: "#10B981",
};

type SlabRow = {
  slot: number;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  circulation_count: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  badges: string[] | null;
  note: string | null;
  collection_id: string;
  collection_slug: string | null;
  edition_id: string | null;
  collection_display_name: string | null;
  series: number | null;
};

function hexToRgb(hex: string): ReturnType<typeof rgb> {
  const h = hex.replace("#", "");
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}
function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
function tierHex(tier: string | null): string {
  return TIER_HEX_STR[(tier || "").toUpperCase()] ?? RPC_RED_HEX;
}

// ───────────────────────── moment art pipeline ─────────────────────────

// Rewrite a thumbnail URL so its bytes are pdf-embeddable + print-quality:
// - format=webp/avif → format=jpeg (Dapper media APIs parameterize format)
// - width < 440 → width=440 (both assets.nbatopshot.com + media hosts honor it)
// - public IPFS gateways → same-origin edge-cached proxy
function normalizeThumbUrl(url: string): string {
  // Same-origin relative paths (e.g. Pinnacle's /api/public/pinnacle-image/<key>)
  // must be absolutized for Node fetch.
  if (url.startsWith("/")) return `${BASE_URL}${url}`;
  const m = url.match(IPFS_GATEWAY_RE);
  if (m) return `${BASE_URL}/api/public/ipfs-media/${m[1]}`;
  try {
    const u = new URL(url);
    const fmt = u.searchParams.get("format");
    if (fmt && /^(webp|avif)$/i.test(fmt)) u.searchParams.set("format", "jpeg");
    const w = Number(u.searchParams.get("width"));
    if (Number.isFinite(w) && w > 0 && w < 440) u.searchParams.set("width", "440");
    return u.toString();
  } catch {
    return url;
  }
}

type Rgba = { width: number; height: number; data: Uint8Array };

function decodeToRgba(bytes: Buffer): Rgba | null {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      const png = PNG.sync.read(bytes);
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      const out = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 128 });
      return { width: out.width, height: out.height, data: new Uint8Array(out.data) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Detect a uniform near-white or near-black background (sampled on the image
// border), flood-fill it to transparent from the borders (so same-colored
// pixels INSIDE the subject survive), then crop to the content bounding box.
// Returns re-encoded PNG bytes, or null if no dominant background was found
// (caller embeds the original bytes untouched).
function stripBackgroundAndCrop(img: Rgba): Buffer | null {
  const { width: w, height: h, data } = img;
  const px = (x: number, y: number) => (y * w + x) * 4;

  let whiteish = 0;
  let blackish = 0;
  let borderCount = 0;
  const sample = (x: number, y: number) => {
    const i = px(x, y);
    const r = data[i], g = data[i + 1], b = data[i + 2];
    borderCount++;
    if (r >= 218 && g >= 218 && b >= 218) whiteish++;
    else if (r <= 45 && g <= 45 && b <= 45) blackish++;
  };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { sample(0, y); sample(w - 1, y); }

  let mode: "white" | "black" | null = null;
  if (whiteish / borderCount >= 0.6) mode = "white";
  else if (blackish / borderCount >= 0.6) mode = "black";
  if (!mode) return null;

  const isBg =
    mode === "white"
      ? (i: number) => data[i] >= 210 && data[i + 1] >= 210 && data[i + 2] >= 210
      : (i: number) => data[i] <= 52 && data[i + 1] <= 52 && data[i + 2] <= 52;

  // BFS flood fill from every border pixel that matches the background.
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const idx = y * w + x;
    if (!visited[idx] && isBg(idx * 4)) { visited[idx] = 1; stack.push(idx); }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length > 0) {
    const idx = stack.pop() as number;
    const x = idx % w, y = (idx / w) | 0;
    data[idx * 4 + 3] = 0; // transparent
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }

  // Content bounding box over remaining opaque pixels.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[px(x, y) + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxX - minX < 8 || maxY - minY < 8) return null; // degenerate

  const margin = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03);
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(w - 1, maxX + margin);
  maxY = Math.min(h - 1, maxY + margin);

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = new PNG({ width: cw, height: ch });
  for (let y = 0; y < ch; y++) {
    const srcStart = px(minX, minY + y);
    out.data.set(data.subarray(srcStart, srcStart + cw * 4), y * cw * 4);
  }
  return PNG.sync.write(out);
}

type FetchedArt = { bytes: Buffer; kind: "png" | "jpg" };

async function fetchMomentArt(url: string): Promise<FetchedArt | null> {
  const target = normalizeThumbUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(target, {
      signal: ac.signal,
      cache: "no-store",
      headers: {
        Accept: "image/jpeg,image/png,image/*",
        // Some Dapper asset CDNs (assets.disneypinnacle.com signed renders)
        // bot-block requests without a browser UA.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) return null;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpg) return null;
    const rgba = decodeToRgba(bytes);
    if (rgba && rgba.width * rgba.height <= 1200 * 1200) {
      const cleaned = stripBackgroundAndCrop(rgba);
      if (cleaned) return { bytes: cleaned, kind: "png" };
    }
    return { bytes, kind: isPng ? "png" : "jpg" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── badge + special-serial icons ─────────────────────────

// Real badge art, collection-correct: Top Shot slabs use TS's own momentTags
// SVGs (the exact art the TS moment page renders); NFL All Day slabs use the
// AllDay badgesV3 set. Both served through our own /api/badge-image proxy
// (slug allowlist there is the injection guard). RPC-brand glyphs remain only
// as soft-fail fallback + for collections with no badge art source.
const TOPSHOT_BADGE_SVG_SLUG: Record<string, string> = {
  "rookie-year": "rookieYear",
  "rookie-mint": "rookieMint",
  "rookie-premiere": "rookiePremiere",
  "rookie-of-the-year": "rookieOfTheYear",
  "top-shot-debut": "topShotDebut",
  "championship-year": "championshipYear",
  "three-stars": "threeStars",
};
const ALLDAY_BADGE_SVG_SLUG: Record<string, string> = {
  "rookie-mint": "rookie-mint",
  "rookie-year": "rookie-year",
  "championship-year": "championship-year",
  "all-day-debut": "all-day-debut",
  "dynamic-moment": "dynamic-moment",
  "hall-of-fame": "hall-of-fame",
  "challenge-reward": "challenge-reward",
  "crafted-reward": "crafted-reward",
};

// Original RPC-brand glyphs (NOT Dapper art) for badges whose upstream art is
// unavailable, in SpecialSerialGlyph's monoline style. 24×24 viewBox.
const GLYPH = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

const STAR = "M12 3.2 L14.3 8.6 L20.2 9.1 L15.8 13 L17.1 18.8 L12 15.7 L6.9 18.8 L8.2 13 L3.8 9.1 L9.7 8.6 Z";
const BADGE_GLYPH_BODY: Record<string, string> = {
  "rookie-year": `<path d="${STAR}"/>`,
  "rookie-mint": `<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5 L13.5 10.2 L17.5 10.5 L14.5 13.1 L15.4 17 L12 14.9 L8.6 17 L9.5 13.1 L6.5 10.5 L10.5 10.2 Z"/>`,
  "championship-year": `<circle cx="12" cy="14.5" r="6.5"/><path d="M9.2 5 H14.8 L16.5 8.6 L12 10.5 L7.5 8.6 Z"/>`,
  "rookie-premiere": `<path d="M12 2.8 L13.9 7.2 L18.7 7.6 L15.1 10.8 L16.2 15.5 L12 13 L7.8 15.5 L8.9 10.8 L5.3 7.6 L10.1 7.2 Z"/><path d="M8 16.5 L7 21.5 L12 19 L17 21.5 L16 16.5"/>`,
  "rookie-of-the-year": `<path d="M7 4 H17 V9 A5 5 0 0 1 7 9 Z"/><path d="M7 5.5 H4.5 A0.2 0.2 0 0 0 4.5 9.5 A3.5 3.5 0 0 0 7.4 11"/><path d="M17 5.5 H19.5 A0.2 0.2 0 0 1 19.5 9.5 A3.5 3.5 0 0 1 16.6 11"/><path d="M12 14 V17 M9 20 H15 M10 17 H14 L15 20 H9 Z"/>`,
  "top-shot-debut": `<circle cx="12" cy="14" r="4.5"/><path d="M12 2.5 V6.5 M5.3 5.3 L8 8 M18.7 5.3 L16 8"/>`,
  "three-stars": `<path d="M6 10.5 L6.9 12.6 L9.2 12.8 L7.5 14.3 L8 16.6 L6 15.4 L4 16.6 L4.5 14.3 L2.8 12.8 L5.1 12.6 Z"/><path d="M12 5.5 L12.9 7.6 L15.2 7.8 L13.5 9.3 L14 11.6 L12 10.4 L10 11.6 L10.5 9.3 L8.8 7.8 L11.1 7.6 Z"/><path d="M18 10.5 L18.9 12.6 L21.2 12.8 L19.5 14.3 L20 16.6 L18 15.4 L16 16.6 L16.5 14.3 L14.8 12.8 L17.1 12.6 Z"/>`,
  "generic": `<circle cx="12" cy="10" r="5.5"/><path d="M9.5 14.5 L8.5 21 L12 18.7 L15.5 21 L14.5 14.5"/>`,
};

// Special-serial glyphs (gold) — medal (#1 / 1-of-1), jersey, target (perfect).
const SPECIAL_GLYPH_BODY: Record<string, string> = {
  first: `<circle cx="12" cy="9" r="6"/><path d="M9 14 L8 22 L12 19 L16 22 L15 14"/><circle cx="12" cy="9" r="2.1" fill="#F59E0B" stroke="none"/>`,
  jersey: `<path d="M8 3.5 L4 6.5 L6 10 L8 8.8 V20.5 H16 V8.8 L18 10 L20 6.5 L16 3.5 A4 4 0 0 1 8 3.5 Z"/>`,
  perfect: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1.4" fill="#F59E0B" stroke="none"/>`,
};

function normBadgeKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Rasterize an SVG string to a PNG buffer via satori/resvg (next/og) —
// pdf-lib embeds PNG/JPEG only.
async function svgToPng(svg: string, size = 96): Promise<Buffer | null> {
  try {
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
    const resp = new ImageResponse(
      // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
      (<img src={dataUri} width={size} height={size} />),
      { width: size, height: size },
    );
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

async function fetchBadgeSvg(slug: string, src: "topshot" | "allday"): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(`${BASE_URL}/api/badge-image?src=${src}&name=${encodeURIComponent(slug)}`, {
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("svg")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve a PNG icon per (collection, badge title). Map key: `${coll}|${key}`.
async function resolveBadgeIcons(pairs: Array<{ title: string; coll: string }>): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const unique = new Map<string, { key: string; coll: string }>();
  for (const p of pairs) {
    const key = normBadgeKey(p.title);
    if (key) unique.set(`${p.coll}|${key}`, { key, coll: p.coll });
  }
  await Promise.all(
    Array.from(unique.entries()).map(async ([mapKey, { key, coll }]) => {
      let png: Buffer | null = null;
      const slug = coll === "nfl_all_day" ? ALLDAY_BADGE_SVG_SLUG[key] : TOPSHOT_BADGE_SVG_SLUG[key];
      if (slug) {
        const svg = await fetchBadgeSvg(slug, coll === "nfl_all_day" ? "allday" : "topshot");
        if (svg) png = await svgToPng(svg);
      }
      if (!png) {
        const body = BADGE_GLYPH_BODY[key] ?? BADGE_GLYPH_BODY["generic"];
        png = await svgToPng(GLYPH(body, "#D1D5DB"));
      }
      if (png) out.set(mapKey, png);
    }),
  );
  return out;
}

// Special-serial categories per the canonical definition (#1 / jersey /
// perfect). 1-of-1 renders the medal.
function specialCats(s: SlabRow, jersey: number | null): Array<keyof typeof SPECIAL_GLYPH_BODY> {
  const serial = s.serial_number;
  const circ = s.circulation_count;
  if (!serial) return [];
  const cats: Array<keyof typeof SPECIAL_GLYPH_BODY> = [];
  if (serial === 1) cats.push("first");
  if (jersey != null && jersey > 0 && serial === jersey) cats.push("jersey");
  if (circ != null && circ > 1 && serial === circ) cats.push("perfect");
  return cats;
}

// ───────────────────────── v6 brand assets (module-cached) ─────────────────────────

async function fetchBytes(url: string, timeoutMs = 6000): Promise<Buffer | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, cache: "no-store" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Brand fonts (OFL, vendored under public/fonts). Cached across warm invocations.
let fontsPromise: Promise<{ display: Buffer | null; mono: Buffer | null }> | null = null;
function loadBrandFonts() {
  if (!fontsPromise) {
    fontsPromise = (async () => ({
      display: await fetchBytes(`${BASE_URL}/fonts/BarlowCondensed-Black.ttf`),
      mono: await fetchBytes(`${BASE_URL}/fonts/ShareTechMono-Regular.ttf`),
    }))();
  }
  return fontsPromise;
}

let logoPromise: Promise<Buffer | null> | null = null;
function loadLogo() {
  if (!logoPromise) logoPromise = fetchBytes(`${BASE_URL}/rip-packs-city-logo.png`);
  return logoPromise;
}

// Per-collection watermark motifs — faint monoline glyphs drawn behind each
// slab's art (original RPC shapes, not league marks): basketball (Top Shot),
// football (All Day), soccer ball (Golazos), pin-crest (Pinnacle), cage
// octagon (UFC). Rendered once per (collection, accent) and cached.
const WATERMARK_BODY: Record<string, string> = {
  nba_top_shot: `<circle cx="12" cy="12" r="9"/><path d="M3 12 H21 M12 3 V21 M5.2 5.8 C8 8.4 8 15.6 5.2 18.2 M18.8 5.8 C16 8.4 16 15.6 18.8 18.2"/>`,
  nfl_all_day: `<ellipse cx="12" cy="12" rx="9.5" ry="6" transform="rotate(-32 12 12)"/><path d="M8.6 13.8 L15.4 10.2 M10 15.4 L14.8 12.9 M9.2 12.2 L14 9.7" transform="rotate(-3 12 12)"/>`,
  laliga_golazos: `<circle cx="12" cy="12" r="9"/><path d="M12 7.6 L15.8 10.4 L14.4 14.9 H9.6 L8.2 10.4 Z"/><path d="M12 3 V7.6 M15.8 10.4 L20.4 9.4 M14.4 14.9 L17.4 18.6 M9.6 14.9 L6.6 18.6 M8.2 10.4 L3.6 9.4"/>`,
  disney_pinnacle: `<path d="M12 2.6 L19 6 V12.2 C19 16.6 16 20 12 21.8 C8 20 5 16.6 5 12.2 V6 Z"/><circle cx="12" cy="11.6" r="2.2"/>`,
  ufc_strike: `<path d="M8 3 H16 L21 8 V16 L16 21 H8 L3 16 V8 Z"/><path d="M9 5.4 H15 L18.6 9 V15 L15 18.6 H9 L5.4 15 V9 Z" opacity="0.6"/>`,
};
const wmCache = new Map<string, Buffer | null>();
async function watermarkArt(collSlug: string, accentHex: string): Promise<Buffer | null> {
  const body = WATERMARK_BODY[collSlug] ?? null;
  if (!body) return null;
  const key = `${collSlug}|${accentHex}`;
  if (wmCache.has(key)) return wmCache.get(key) ?? null;
  // opacity on a <g> wrapper (root-svg opacity is unreliable through the
  // rasterizer) — strong enough to peek from behind the art.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><g stroke="${accentHex}" stroke-width="0.9" stroke-linejoin="round" opacity="0.22">${body}</g></svg>`;
  const png = await svgToPng(svg, 320);
  wmCache.set(key, png);
  return png;
}

// Branded placeholder art tile — a tier-colored pin-crest glyph on a soft
// radial glow, used when a slab's art can't be embedded server-side (notably
// Disney Pinnacle: assets.disneypinnacle.com 403s ALL datacenter egress, so
// only a browser can fetch those renders — see app/api/public/pinnacle-image).
// Reads as a deliberate design element, not a broken image. Cached per accent.
const phCache = new Map<string, Buffer | null>();
async function placeholderArt(accentHex: string): Promise<Buffer | null> {
  if (phCache.has(accentHex)) return phCache.get(accentHex) ?? null;
  const crest = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${accentHex}" stroke-width="1.1" stroke-linejoin="round"><path d="M12 2.6 L19 6 V12.2 C19 16.6 16 20 12 21.8 C8 20 5 16.6 5 12.2 V6 Z"/><path d="M12 6.2 L16 8.2 V12.4 C16 15 14.2 17.2 12 18.4 C9.8 17.2 8 15 8 12.4 V8.2 Z" opacity="0.55"/><circle cx="12" cy="11.6" r="1.7" fill="${accentHex}" stroke="none" opacity="0.8"/></svg>`;
  const png = await svgToPng(crest, 288);
  phCache.set(accentHex, png);
  return png;
}

// "Holo slab" background — satori-rendered per accent variant: dark gradient
// panel, colored top glow, soft shadow well under the art, hairline top edge.
// Rendered at 3× (688×672) and drawn at cell size. Cached per accent.
const slabBgCache = new Map<string, Buffer | null>();
async function slabBg(accentHex: string, glow: boolean): Promise<Buffer | null> {
  const key = `${accentHex}|${glow}`;
  if (slabBgCache.has(key)) return slabBgCache.get(key) ?? null;
  let buf: Buffer | null = null;
  try {
    const resp = new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            position: "relative",
            borderRadius: 28,
            border: `4px solid ${accentHex}`,
            background: "linear-gradient(165deg, #1b1b20 0%, #0c0c0e 52%, #121218 100%)",
            overflow: "hidden",
          }}
        >
          {glow ? (
            <div
              style={{
                position: "absolute",
                top: -160,
                left: 84,
                width: 520,
                height: 420,
                display: "flex",
                background: `radial-gradient(circle, ${hexToRgba(accentHex, 0.28)} 0%, rgba(0,0,0,0) 62%)`,
              }}
            />
          ) : null}
          <div
            style={{
              position: "absolute",
              left: 110,
              top: 396,
              width: 468,
              height: 44,
              display: "flex",
              background: "radial-gradient(ellipse, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 70%)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 34,
              right: 34,
              top: 5,
              height: 2,
              display: "flex",
              background: hexToRgba(accentHex, 0.35),
            }}
          />
        </div>
      ),
      { width: 688, height: 672 },
    );
    buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength === 0) buf = null;
  } catch {
    buf = null;
  }
  slabBgCache.set(key, buf);
  return buf;
}

// ───────────────────────── text helpers ─────────────────────────

function truncate(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

// Strip characters outside Latin-1 so neither WinAnsi (fallback fonts) nor the
// embedded subsets ever throw on emoji/unicode in player names or notes.
function ansi(text: string): string {
  return text.replace(/[^\x20-\x7E -ÿ]/g, "").replace(/\s+/g, " ").trim();
}

// ───────────────────────── route ─────────────────────────

export async function GET(req: NextRequest) {
  const username = (req.nextUrl.searchParams.get("username") || "").trim();
  if (!username || username.length > 64) {
    return NextResponse.json({ error: "Provide ?username=<u>" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = supabaseAnon;
  const { data, error } = await client.rpc("get_trophy_slab_data_by_username", {
    p_username: username,
  });
  if (error) {
    console.log("[trophy-case pdf] rpc error", error?.message || error);
    return NextResponse.json({ error: "lookup_failed" }, { status: 502 });
  }
  const slabs: SlabRow[] = Array.isArray(data) ? (data as SlabRow[]) : [];
  if (slabs.length === 0) {
    return NextResponse.json({ error: "no_trophy_case" }, { status: 404 });
  }

  // Positional ordering — mirrors the on-page trophy case (ProfileClient
  // renders slabs[i] for i in 0..5 off the same RPC's array order).
  const ordered = slabs.slice(0, 6);
  const slotAt = (i: number): SlabRow | null => ordered[i] ?? null;

  // Jersey numbers (jersey-match glyph) + edition UUIDs — one anon catalog
  // read keyed by (collection_id, external_id). Failure is soft.
  const jerseyByKey = new Map<string, number>();
  const editionUuidByKey = new Map<string, string>();
  try {
    const ids = ordered.map((s) => s.edition_id).filter((v): v is string => !!v);
    if (ids.length > 0) {
      const { data: eds } = await client
        .from("editions")
        .select("id, external_id, collection_id, jersey_number")
        .in("external_id", ids);
      for (const e of (eds as Array<{ id: string; external_id: string; collection_id: string; jersey_number: number | null }>) || []) {
        editionUuidByKey.set(`${e.collection_id}:${e.external_id}`, e.id);
        if (e.jersey_number != null) jerseyByKey.set(`${e.collection_id}:${e.external_id}`, Number(e.jersey_number));
      }
    }
  } catch {
    /* glyphs degrade silently */
  }

  // Badges per slab: merge the slab RPC's snapshot with the site's canonical
  // badge source (get_edition_badges_unified).
  const badgesBySlab = new Map<number, string[]>();
  await Promise.all(
    ordered.map(async (s, i) => {
      const titles = new Set<string>(
        (Array.isArray(s.badges) ? s.badges : []).filter((b): b is string => typeof b === "string" && !!b.trim()),
      );
      const uuid = s.edition_id ? editionUuidByKey.get(`${s.collection_id}:${s.edition_id}`) : null;
      if (uuid) {
        try {
          const { data: ub } = await client.rpc("get_edition_badges_unified", { p_edition_id: uuid });
          for (const b of (ub as Array<{ title?: string | null }>) || []) {
            if (b?.title && typeof b.title === "string") titles.add(b.title.trim());
          }
        } catch {
          /* soft */
        }
      }
      badgesBySlab.set(i, Array.from(titles));
    }),
  );

  // Fetch everything in parallel: art, badge icons, special glyphs, brand assets, QR.
  const badgePairs = ordered.flatMap((s, i) =>
    (badgesBySlab.get(i) || []).map((title) => ({ title, coll: s.collection_slug || "" })),
  );
  const profileUrl = `${BASE_URL}/profile/${encodeURIComponent(username)}`;
  const [images, badgeIcons, specialIcons, fonts, logoBytes, qrBytes] = await Promise.all([
    Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (i) => {
        const s = slotAt(i);
        if (!s?.thumbnail_url) return null;
        return fetchMomentArt(s.thumbnail_url);
      }),
    ),
    resolveBadgeIcons(badgePairs),
    (async () => {
      const m = new Map<string, Buffer>();
      for (const [cat, body] of Object.entries(SPECIAL_GLYPH_BODY)) {
        const png = await svgToPng(GLYPH(body, GOLD_HEX));
        if (png) m.set(cat, png);
      }
      return m;
    })(),
    loadBrandFonts(),
    loadLogo(),
    QRCode.toBuffer(profileUrl, {
      type: "png",
      margin: 1,
      width: 220,
      errorCorrectionLevel: "M",
      color: { dark: "#0A0A0AFF", light: "#FFFFFFFF" },
    }).catch(() => null),
  ]);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${username} — Trophy Case | Rip Packs City`);
  pdf.setAuthor("Rip Packs City");
  pdf.setCreator("rippackscity.com");

  const W = 792; // Letter landscape
  const H = 612;
  const page = pdf.addPage([W, H]);

  // Brand fonts with Standard-14 fallback so the export never 500s on a
  // font-fetch hiccup.
  const display = fonts.display
    ? await pdf.embedFont(fonts.display, { subset: true }).catch(() => null)
    : null;
  const mono = fonts.mono
    ? await pdf.embedFont(fonts.mono, { subset: true }).catch(() => null)
    : null;
  const dsp = display ?? (await pdf.embedFont(StandardFonts.HelveticaBold));
  const mno = mono ?? (await pdf.embedFont(StandardFonts.Helvetica));

  const black = rgb(0.04, 0.04, 0.04);
  const white = rgb(1, 1, 1);
  const gray = rgb(0.61, 0.64, 0.69);
  const ghost = rgb(0.42, 0.45, 0.5);
  const red = hexToRgb(RPC_RED_HEX);
  const gold = hexToRgb(GOLD_HEX);

  // Pre-embed repeated images.
  const embeddedBadge = new Map<string, PDFImage>();
  for (const [k, buf] of badgeIcons) {
    try { embeddedBadge.set(k, await pdf.embedPng(buf)); } catch { /* skip */ }
  }
  const embeddedSpecial = new Map<string, PDFImage>();
  for (const [k, buf] of specialIcons) {
    try { embeddedSpecial.set(k, await pdf.embedPng(buf)); } catch { /* skip */ }
  }

  // Background + header
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: black });
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: red });

  page.drawText("TROPHY CASE", { x: 36, y: H - 58, size: 42, font: dsp, color: white });
  const uname = ansi(username) || "collector";
  page.drawText(`@${uname}`, { x: 36, y: H - 78, size: 11, font: mno, color: red });

  let logoDrawn = false;
  if (logoBytes) {
    try {
      const logo = await pdf.embedPng(logoBytes);
      const lw = 48;
      const lh = (logo.height / logo.width) * lw;
      page.drawImage(logo, { x: W - 36 - lw, y: H - 20 - lh, width: lw, height: lh });
      logoDrawn = true;
    } catch { /* text fallback below */ }
  }
  if (!logoDrawn) {
    const rl = "RIP PACKS CITY";
    page.drawText(rl, { x: W - 36 - dsp.widthOfTextAtSize(rl, 15), y: H - 44, size: 15, font: dsp, color: red });
  }
  const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const sub = `rippackscity.com/profile/${uname} · ${dateStr}`;
  page.drawText(sub, {
    x: W - 36 - mno.widthOfTextAtSize(sub, 8),
    y: H - 78,
    size: 8,
    font: mno,
    color: ghost,
  });

  // 3×2 slab grid
  const cols = 3;
  const gutter = 16;
  const gutterY = 14;
  const cellW = (W - 36 * 2 - gutter * (cols - 1)) / cols; // 229.33
  const cellH = 224;
  const row0Y = 512 - cellH; // 288
  const artBox = 144;

  for (let i = 0; i < 6; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 36 + col * (cellW + gutter);
    const y = row === 0 ? row0Y : row0Y - gutterY - cellH;
    const s = slotAt(i);

    const jersey = s?.edition_id ? jerseyByKey.get(`${s.collection_id}:${s.edition_id}`) ?? null : null;
    const chips = s ? specialCats(s, jersey) : [];
    const isOneOfOne = !!s && s.serial_number === 1 && s.circulation_count === 1;
    const accent = !s ? "#3A3A40" : isOneOfOne ? GOLD_HEX : tierHex(s.tier);

    // Holo slab panel (satori PNG); flat-rect fallback if rendering failed.
    const bg = await slabBg(accent, !!s);
    if (bg) {
      try {
        const bgImg = await pdf.embedPng(bg);
        page.drawImage(bgImg, { x, y, width: cellW, height: cellH });
      } catch {
        page.drawRectangle({ x, y, width: cellW, height: cellH, color: rgb(0.09, 0.09, 0.1), borderColor: hexToRgb(accent), borderWidth: 1.5 });
      }
    } else {
      page.drawRectangle({ x, y, width: cellW, height: cellH, color: rgb(0.09, 0.09, 0.1), borderColor: hexToRgb(accent), borderWidth: 1.5 });
    }

    if (!s) {
      const lbl = `SLOT ${i + 1}`;
      page.drawText(lbl, {
        x: x + (cellW - dsp.widthOfTextAtSize(lbl, 12)) / 2,
        y: y + cellH / 2 + 6, size: 12, font: dsp, color: ghost,
      });
      const empty = "EMPTY";
      page.drawText(empty, {
        x: x + (cellW - mno.widthOfTextAtSize(empty, 8)) / 2,
        y: y + cellH / 2 - 10, size: 8, font: mno, color: rgb(0.3, 0.32, 0.35),
      });
      continue;
    }

    // Faint collection motif — anchored top-left so it PEEKS out beside the
    // centered art instead of hiding entirely behind it.
    const wm = await watermarkArt(s.collection_slug || "", tierHex(s.tier));
    if (wm) {
      try {
        const wmImg = await pdf.embedPng(wm);
        const wmSize = 104;
        page.drawImage(wmImg, { x: x + 4, y: y + cellH - 14 - wmSize, width: wmSize, height: wmSize });
      } catch { /* skip */ }
    }

    // Moment art — contain-fit, centered, floating on the slab.
    const boxCx = x + cellW / 2;
    const boxTop = y + cellH - 10;
    const fetched = images[i];
    let embedded: PDFImage | null = null;
    if (fetched) {
      try {
        embedded = fetched.kind === "png" ? await pdf.embedPng(fetched.bytes) : await pdf.embedJpg(fetched.bytes);
      } catch {
        embedded = null;
      }
    }
    if (embedded) {
      const scale = Math.min(artBox / embedded.width, artBox / embedded.height);
      const dw = embedded.width * scale;
      const dh = embedded.height * scale;
      page.drawImage(embedded, { x: boxCx - dw / 2, y: boxTop - artBox + (artBox - dh) / 2, width: dw, height: dh });
    } else {
      const phPng = await placeholderArt(accent);
      let drawn = false;
      if (phPng) {
        try {
          const phImg = await pdf.embedPng(phPng);
          const phSize = artBox * 0.62;
          page.drawImage(phImg, { x: boxCx - phSize / 2, y: boxTop - artBox + (artBox - phSize) / 2, width: phSize, height: phSize });
          drawn = true;
        } catch { /* text fallback */ }
      }
      if (!drawn) {
        const ph = "RPC";
        page.drawText(ph, {
          x: boxCx - dsp.widthOfTextAtSize(ph, 18) / 2,
          y: boxTop - artBox / 2 - 7, size: 18, font: dsp, color: rgb(0.22, 0.22, 0.26),
        });
      }
    }

    // Text block
    const pad = 12;
    const name = truncate(dsp, ansi(s.player_name || "Moment").toUpperCase(), 14, cellW - pad * 2);
    page.drawText(name, { x: x + pad, y: y + 56, size: 14, font: dsp, color: white });

    const setLine = [s.set_name, s.series != null ? `S${s.series}` : null].filter(Boolean).join(" · ");
    if (setLine) {
      page.drawText(truncate(mno, ansi(setLine), 7.5, cellW - pad * 2), { x: x + pad, y: y + 45, size: 7.5, font: mno, color: gray });
    }

    // Serial hero — the flex. Gold when the serial is special.
    const serialColor = chips.length > 0 ? gold : hexToRgb(tierHex(s.tier));
    const serialTxt = s.serial_number
      ? `#${s.serial_number}${s.circulation_count ? ` / ${s.circulation_count}` : ""}`
      : (s.circulation_count ? `${s.circulation_count} MINTED` : "");
    if (serialTxt) {
      page.drawText(truncate(dsp, serialTxt, 18, cellW - pad * 2 - 60), { x: x + pad, y: y + 25, size: 18, font: dsp, color: serialColor });
    }
    const tierTxt = (s.tier || "").toUpperCase();
    if (tierTxt) {
      page.drawText(tierTxt, {
        x: x + cellW - pad - mno.widthOfTextAtSize(tierTxt, 7.5),
        y: y + 30, size: 7.5, font: mno, color: hexToRgb(tierHex(s.tier)),
      });
    }

    // Icon row: gold special glyphs, then real badge art.
    const iconSize = 15;
    let ix = x + pad;
    for (const cat of chips) {
      const img = embeddedSpecial.get(cat);
      if (!img || ix + iconSize > x + cellW - 76) continue;
      page.drawImage(img, { x: ix, y: y + 6, width: iconSize, height: iconSize });
      ix += iconSize + 5;
    }
    const badges = badgesBySlab.get(i) || [];
    if (badges.length > 0 && ix > x + pad) ix += 3;
    for (const b of badges) {
      const img = embeddedBadge.get(`${s.collection_slug || ""}|${normBadgeKey(b)}`);
      if (!img || ix + iconSize > x + cellW - 76) continue;
      page.drawImage(img, { x: ix, y: y + 6, width: iconSize, height: iconSize });
      ix += iconSize + 5;
    }

    // Collector's note — small gray line after the icon row (never overlaps).
    const note = ansi(String(s.note || "")).trim();
    if (note) {
      const nx = ix + (ix > x + pad ? 4 : 2);
      const maxW = x + cellW - 90 - nx;
      if (maxW > 30) {
        page.drawText(truncate(mno, `"${note}"`, 7, maxW), {
          x: nx, y: y + 10, size: 7, font: mno, color: rgb(0.5, 0.53, 0.58),
        });
      }
    }

    // Collection tag bottom-right.
    const collTag = ansi(s.collection_display_name || "").toUpperCase();
    if (collTag) {
      page.drawText(truncate(mno, collTag, 6.5, 74), {
        x: x + cellW - pad - Math.min(mno.widthOfTextAtSize(collTag, 6.5), 74),
        y: y + 9, size: 6.5, font: mno, color: ghost,
      });
    }
  }

  // Footer — brand + QR deep link, deliberately no valuation.
  page.drawRectangle({ x: 0, y: 0, width: W, height: 4, color: red });
  page.drawText("RIP PACKS CITY", { x: 36, y: 18, size: 13, font: dsp, color: red });
  let ctaRight = W - 36;
  if (qrBytes) {
    try {
      const qr = await pdf.embedPng(qrBytes);
      const qs = 38;
      page.drawImage(qr, { x: W - 36 - qs, y: 7, width: qs, height: qs });
      ctaRight = W - 36 - qs - 10;
    } catch { /* text-only footer */ }
  }
  const cta = "Scan or visit rippackscity.com to build yours";
  page.drawText(cta, {
    x: ctaRight - mno.widthOfTextAtSize(cta, 8.5),
    y: 20,
    size: 8.5,
    font: mno,
    color: gray,
  });

  const bytes = await pdf.save();
  const safeName = uname.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "collector";
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="rpc-trophy-case-${safeName}.pdf"`,
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
