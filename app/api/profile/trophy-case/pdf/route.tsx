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
// Art pipeline (v3):
// - Moment art is decoded (jpeg-js / pngjs), its uniform white OR black
//   background is flood-filled to transparency from the borders, and the
//   result is cropped to content — so every slab's art blends into the dark
//   slab panel and fills the tile regardless of how much dead margin the
//   upstream asset ships with (the AllDay ring art is mostly white padding).
// - Badge ICONS (not text pills): real Dapper badge SVGs where they exist
//   (served through our own /api/badge-image allowlist proxy — the shared
//   badgesV3 set covers Rookie Mint / Rookie Year / Championship Year /
//   Debut / etc). The Top Shot-only badges whose upstream art is dead
//   (Rookie Premiere, Rookie of the Year, Top Shot Debut, Three Stars) get
//   original RPC-brand glyphs — same precedent as SpecialSerialGlyph.
//   SVGs are rasterized to PNG via satori (next/og ImageResponse), since
//   pdf-lib embeds only PNG/JPEG.
// - Special serials render as gold brand glyphs: medal (#1 / 1-of-1),
//   jersey (serial == jersey number), target (perfect mint).

import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
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
const RPC_RED = { r: 0xe0 / 255, g: 0x3a / 255, b: 0x2f / 255 };
const TIER_HEX: Record<string, [number, number, number]> = {
  COMMON: [0x9c, 0xa3, 0xaf],
  FANDOM: [0x10, 0xb9, 0x81],
  RARE: [0x3b, 0x82, 0xf6],
  LEGENDARY: [0xf5, 0x9e, 0x0b],
  ULTIMATE: [0xef, 0x44, 0x44],
  CONTENDER: [0x9c, 0xa3, 0xaf],
  CHALLENGER: [0x3b, 0x82, 0xf6],
  UNCOMMON: [0x10, 0xb9, 0x81],
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

function tierColor(tier: string | null): ReturnType<typeof rgb> {
  const t = TIER_HEX[(tier || "").toUpperCase()];
  return t ? rgb(t[0] / 255, t[1] / 255, t[2] / 255) : rgb(RPC_RED.r, RPC_RED.g, RPC_RED.b);
}

// ───────────────────────── moment art pipeline ─────────────────────────

// Rewrite a thumbnail URL so its bytes are pdf-embeddable + print-quality:
// - format=webp/avif → format=jpeg (Dapper media APIs parameterize format)
// - width < 440 → width=440 (both assets.nbatopshot.com + media hosts honor it)
// - public IPFS gateways → same-origin edge-cached proxy
function normalizeThumbUrl(url: string): string {
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
    const res = await fetch(target, { signal: ac.signal, cache: "no-store", headers: { Accept: "image/jpeg,image/png,image/*" } });
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
// SVGs (the exact art the TS moment page renders — found live at
// assets.nbatopshot.com/static/momentTags/static/<slug>.svg, 2026-07-07);
// NFL All Day slabs use the AllDay badgesV3 set. Both served through our own
// /api/badge-image proxy (slug allowlist there is the injection guard).
// RPC-brand glyphs remain only as soft-fail fallback + for collections with
// no badge art source.
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
// gone, in SpecialSerialGlyph's monoline style. 24×24 viewBox, stroke-based.
const GLYPH = (body: string, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

const STAR = "M12 3.2 L14.3 8.6 L20.2 9.1 L15.8 13 L17.1 18.8 L12 15.7 L6.9 18.8 L8.2 13 L3.8 9.1 L9.7 8.6 Z";
const BADGE_GLYPH_BODY: Record<string, string> = {
  // Rookie Year — plain star
  "rookie-year": `<path d="${STAR}"/>`,
  // Rookie Mint — star struck on a coin
  "rookie-mint": `<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5 L13.5 10.2 L17.5 10.5 L14.5 13.1 L15.4 17 L12 14.9 L8.6 17 L9.5 13.1 L6.5 10.5 L10.5 10.2 Z"/>`,
  // Championship Year — champion ring with gem
  "championship-year": `<circle cx="12" cy="14.5" r="6.5"/><path d="M9.2 5 H14.8 L16.5 8.6 L12 10.5 L7.5 8.6 Z"/>`,
  // Rookie Premiere — star over a premiere ribbon
  "rookie-premiere": `<path d="M12 2.8 L13.9 7.2 L18.7 7.6 L15.1 10.8 L16.2 15.5 L12 13 L7.8 15.5 L8.9 10.8 L5.3 7.6 L10.1 7.2 Z"/><path d="M8 16.5 L7 21.5 L12 19 L17 21.5 L16 16.5"/>`,
  // Rookie of the Year — trophy cup
  "rookie-of-the-year": `<path d="M7 4 H17 V9 A5 5 0 0 1 7 9 Z"/><path d="M7 5.5 H4.5 A0.2 0.2 0 0 0 4.5 9.5 A3.5 3.5 0 0 0 7.4 11"/><path d="M17 5.5 H19.5 A0.2 0.2 0 0 1 19.5 9.5 A3.5 3.5 0 0 1 16.6 11"/><path d="M12 14 V17 M9 20 H15 M10 17 H14 L15 20 H9 Z"/>`,
  // Top Shot Debut — rising spark / tip-off arc
  "top-shot-debut": `<circle cx="12" cy="14" r="4.5"/><path d="M12 2.5 V6.5 M5.3 5.3 L8 8 M18.7 5.3 L16 8"/>`,
  // Three Stars
  "three-stars": `<path d="M6 10.5 L6.9 12.6 L9.2 12.8 L7.5 14.3 L8 16.6 L6 15.4 L4 16.6 L4.5 14.3 L2.8 12.8 L5.1 12.6 Z"/><path d="M12 5.5 L12.9 7.6 L15.2 7.8 L13.5 9.3 L14 11.6 L12 10.4 L10 11.6 L10.5 9.3 L8.8 7.8 L11.1 7.6 Z"/><path d="M18 10.5 L18.9 12.6 L21.2 12.8 L19.5 14.3 L20 16.6 L18 15.4 L16 16.6 L16.5 14.3 L14.8 12.8 L17.1 12.6 Z"/>`,
  // generic fallback — rosette
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

// Resolve a PNG icon per (collection, badge title). NFL All Day slabs get the
// real AllDay badgesV3 art; every other collection gets RPC-brand glyphs
// (Top Shot's own badge-art upstream is dead — never paint AllDay designs on
// TS moments). Map key: `${collectionSlug}|${normalizedTitle}`.
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
// perfect — see special-serials memory). 1-of-1 renders the medal.
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

// ───────────────────────── text helpers ─────────────────────────

function truncate(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + "…", size) > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

// Strip characters WinAnsi (the Standard-14 font encoding) can't represent so
// pdf-lib never throws on emoji/unicode in player names or notes.
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
  // read keyed by (collection_id, external_id). editions is public-SELECT;
  // failure is soft.
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
  // badge source (get_edition_badges_unified — the same fn the moment/edition
  // pages render from), so the PDF never misses a badge the site shows.
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

  // Fetch everything in parallel: moment art, badge icon PNGs, special glyphs.
  const badgePairs = ordered.flatMap((s, i) =>
    (badgesBySlab.get(i) || []).map((title) => ({ title, coll: s.collection_slug || "" })),
  );
  const [images, badgeIcons, specialIcons] = await Promise.all([
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
        const png = await svgToPng(GLYPH(body, "#F59E0B"));
        if (png) m.set(cat, png);
      }
      return m;
    })(),
  ]);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${username} — Trophy Case | Rip Packs City`);
  pdf.setAuthor("Rip Packs City");
  pdf.setCreator("rippackscity.com");

  const W = 792; // Letter landscape
  const H = 612;
  const page = pdf.addPage([W, H]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);

  const black = rgb(0.04, 0.04, 0.04);
  const panel = rgb(0.09, 0.09, 0.1);
  const white = rgb(1, 1, 1);
  const gray = rgb(0.61, 0.64, 0.69);
  const ghost = rgb(0.42, 0.45, 0.5);
  const red = rgb(RPC_RED.r, RPC_RED.g, RPC_RED.b);

  // Pre-embed icon images once (they repeat across slabs).
  const embeddedBadge = new Map<string, PDFImage>();
  for (const [k, buf] of badgeIcons) {
    try { embeddedBadge.set(k, await pdf.embedPng(buf)); } catch { /* skip */ }
  }
  const embeddedSpecial = new Map<string, PDFImage>();
  for (const [k, buf] of specialIcons) {
    try { embeddedSpecial.set(k, await pdf.embedPng(buf)); } catch { /* skip */ }
  }

  // Background + header band
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: black });
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: red });

  const headerY = H - 52;
  page.drawText("TROPHY CASE", { x: 36, y: headerY, size: 34, font: bold, color: white });
  const uname = ansi(username) || "collector";
  page.drawText(`@${uname}`, { x: 36, y: headerY - 22, size: 13, font: bold, color: red });
  const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  // RPC logo top-right (fetched from our own public asset; falls back to the
  // text wordmark if unavailable).
  let logo: PDFImage | null = null;
  try {
    const lr = await fetch(`${BASE_URL}/rip-packs-city-logo.png`, { cache: "no-store" });
    if (lr.ok) logo = await pdf.embedPng(Buffer.from(await lr.arrayBuffer()));
  } catch { /* fall back to text */ }
  if (logo) {
    const lw = 46;
    const lh = (logo.height / logo.width) * lw;
    page.drawImage(logo, { x: W - 36 - lw, y: H - 22 - lh, width: lw, height: lh });
  } else {
    const rightLabel = "RIP PACKS CITY";
    page.drawText(rightLabel, {
      x: W - 36 - bold.widthOfTextAtSize(rightLabel, 14),
      y: headerY + 8,
      size: 14,
      font: bold,
      color: red,
    });
  }
  const sub = `rippackscity.com/profile/${uname}  ·  ${dateStr}`;
  page.drawText(sub, {
    x: W - 36 - reg.widthOfTextAtSize(sub, 9),
    y: headerY - 22,
    size: 9,
    font: reg,
    color: ghost,
  });

  // 3×2 slab grid
  const gridTop = H - 96;
  const gutter = 16;
  const cols = 3;
  const cellW = (W - 36 * 2 - gutter * (cols - 1)) / cols; // = 229.3
  const cellH = 228;
  const artBox = 148;

  for (let i = 0; i < 6; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 36 + col * (cellW + gutter);
    const y = gridTop - cellH - row * (cellH + gutter);
    const s = slotAt(i);

    page.drawRectangle({
      x, y, width: cellW, height: cellH,
      color: panel, borderColor: s ? tierColor(s.tier) : rgb(0.16, 0.16, 0.18), borderWidth: 1.5,
    });

    if (!s) {
      const lbl = `SLOT ${i + 1}`;
      page.drawText(lbl, {
        x: x + (cellW - bold.widthOfTextAtSize(lbl, 11)) / 2,
        y: y + cellH / 2 + 6, size: 11, font: bold, color: ghost,
      });
      const empty = "EMPTY";
      page.drawText(empty, {
        x: x + (cellW - reg.widthOfTextAtSize(empty, 9)) / 2,
        y: y + cellH / 2 - 10, size: 9, font: reg, color: rgb(0.3, 0.32, 0.35),
      });
      continue;
    }

    // Moment art — contain-fit, centered, floating on the panel (backgrounds
    // are stripped to transparency upstream, so no frame / no fill box).
    const boxCx = x + cellW / 2;
    const boxTop = y + cellH - 12;
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
      page.drawRectangle({ x: boxCx - artBox / 2, y: boxTop - artBox, width: artBox, height: artBox, color: rgb(0.06, 0.06, 0.07) });
      const ph = "RPC";
      page.drawText(ph, {
        x: boxCx - bold.widthOfTextAtSize(ph, 16) / 2,
        y: boxTop - artBox / 2 - 6, size: 16, font: bold, color: rgb(0.25, 0.25, 0.28),
      });
    }

    // Text block
    const pad = 10;
    let ty = boxTop - artBox - 15;
    const name = truncate(bold, ansi(s.player_name || "Moment"), 12, cellW - pad * 2);
    page.drawText(name, { x: x + pad, y: ty, size: 12, font: bold, color: white });
    ty -= 12;

    const setLine = [s.set_name, s.series != null ? `S${s.series}` : null].filter(Boolean).join(" · ");
    if (setLine) {
      page.drawText(truncate(reg, ansi(setLine), 8.5, cellW - pad * 2), { x: x + pad, y: ty, size: 8.5, font: reg, color: gray });
      ty -= 11;
    }

    const serialTxt = s.serial_number
      ? `#${s.serial_number}${s.circulation_count ? ` / ${s.circulation_count}` : ""}`
      : "";
    const tierTxt = (s.tier || "").toUpperCase();
    const meta = [tierTxt, serialTxt].filter(Boolean).join("  ·  ");
    if (meta) {
      page.drawText(truncate(bold, ansi(meta), 8.5, cellW - pad * 2), { x: x + pad, y: ty, size: 8.5, font: bold, color: tierColor(s.tier) });
      ty -= 16;
    }

    // Icon row: gold special-serial glyphs first, then edition badge icons.
    const jersey = s.edition_id ? jerseyByKey.get(`${s.collection_id}:${s.edition_id}`) ?? null : null;
    const iconSize = 16;
    let ix = x + pad;
    for (const cat of specialCats(s, jersey)) {
      const img = embeddedSpecial.get(cat);
      if (!img || ix + iconSize > x + cellW - pad) continue;
      page.drawImage(img, { x: ix, y: ty - 3, width: iconSize, height: iconSize });
      ix += iconSize + 5;
    }
    const badges = badgesBySlab.get(i) || [];
    if (badges.length > 0 && ix > x + pad) ix += 3; // small gap between groups
    for (const b of badges) {
      const img = embeddedBadge.get(`${s.collection_slug || ""}|${normBadgeKey(b)}`);
      if (!img || ix + iconSize > x + cellW - 78) continue; // keep clear of the collection tag
      page.drawImage(img, { x: ix, y: ty - 3, width: iconSize, height: iconSize });
      ix += iconSize + 5;
    }

    // Collection tag bottom-right of the cell
    const collTag = ansi(s.collection_display_name || "").toUpperCase();
    if (collTag) {
      const tagSize = 7;
      page.drawText(truncate(reg, collTag, tagSize, cellW - pad * 2), {
        x: x + cellW - pad - Math.min(reg.widthOfTextAtSize(collTag, tagSize), cellW - pad * 2),
        y: y + 8, size: tagSize, font: reg, color: ghost,
      });
    }
  }

  // Footer — brand only, deliberately no valuation.
  const footY = 22;
  page.drawRectangle({ x: 0, y: 0, width: W, height: 4, color: red });
  page.drawText("RIP PACKS CITY", { x: 36, y: footY, size: 11, font: bold, color: red });
  const cta = "Build yours at rippackscity.com";
  page.drawText(cta, {
    x: W - 36 - reg.widthOfTextAtSize(cta, 10),
    y: footY,
    size: 10,
    font: reg,
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
