// app/api/profile/trophy-case/pdf/route.ts
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
// Images: pdf-lib embeds PNG/JPEG only. The Dapper media APIs parameterize
// format in the URL (media.nflallday.com …&format=webp…), so webp/avif URLs
// are rewritten to format=jpeg before fetch, and low-res width params are
// bumped to 440 for print quality. IPFS-gateway art routes through the
// same-origin edge-cached proxy. A failed/unsupported image degrades to a
// branded placeholder tile, never a 500.

import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
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
const GOLD = rgb(0xf5 / 255, 0x9e / 255, 0x0b / 255);

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
  edition_id: string | null;
  collection_display_name: string | null;
  series: number | null;
};

function tierColor(tier: string | null): ReturnType<typeof rgb> {
  const t = TIER_HEX[(tier || "").toUpperCase()];
  return t ? rgb(t[0] / 255, t[1] / 255, t[2] / 255) : rgb(RPC_RED.r, RPC_RED.g, RPC_RED.b);
}

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

async function fetchImageBytes(url: string): Promise<{ bytes: Buffer; kind: "png" | "jpg" } | null> {
  const target = normalizeThumbUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(target, { signal: ac.signal, cache: "no-store", headers: { Accept: "image/jpeg,image/png,image/*" } });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) return null;
    // pdf-lib embeds PNG + JPEG only — sniff magic bytes, skip anything else.
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { bytes, kind: "png" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { bytes, kind: "jpg" };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

// Special-serial chips per the canonical definition (#1 / jersey / perfect —
// see special-serials): 1-of-1 supersedes, jersey needs editions.jersey_number.
function specialChips(s: SlabRow, jersey: number | null): string[] {
  const serial = s.serial_number;
  const circ = s.circulation_count;
  if (!serial) return [];
  const chips: string[] = [];
  if (circ === 1 && serial === 1) return ["1 OF 1"];
  if (serial === 1) chips.push("#1 MINT");
  if (circ != null && circ > 1 && serial === circ) chips.push("PERFECT MINT");
  if (jersey != null && jersey > 0 && serial === jersey) chips.push("JERSEY MATCH");
  return chips;
}

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

  // Jersey numbers for the JERSEY MATCH chip — one anon catalog read keyed by
  // (collection_id, external_id). editions is public-SELECT; failure is soft.
  const jerseyByKey = new Map<string, number>();
  try {
    const ids = ordered.map((s) => s.edition_id).filter((v): v is string => !!v);
    if (ids.length > 0) {
      const { data: eds } = await client
        .from("editions")
        .select("external_id, collection_id, jersey_number")
        .in("external_id", ids);
      for (const e of (eds as Array<{ external_id: string; collection_id: string; jersey_number: number | null }>) || []) {
        if (e.jersey_number != null) jerseyByKey.set(`${e.collection_id}:${e.external_id}`, Number(e.jersey_number));
      }
    }
  } catch {
    /* chips degrade silently */
  }

  const images = await Promise.all(
    [0, 1, 2, 3, 4, 5].map(async (i) => {
      const s = slotAt(i);
      if (!s?.thumbnail_url) return null;
      return fetchImageBytes(s.thumbnail_url);
    }),
  );

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

  // Background + header band
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: black });
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: red });

  const headerY = H - 52;
  page.drawText("TROPHY CASE", { x: 36, y: headerY, size: 34, font: bold, color: white });
  const uname = ansi(username) || "collector";
  page.drawText(`@${uname}`, { x: 36, y: headerY - 22, size: 13, font: bold, color: red });
  const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const rightLabel = "RIP PACKS CITY";
  page.drawText(rightLabel, {
    x: W - 36 - bold.widthOfTextAtSize(rightLabel, 14),
    y: headerY + 8,
    size: 14,
    font: bold,
    color: red,
  });
  const sub = `rippackscity.com/profile/${uname}  ·  ${dateStr}`;
  page.drawText(sub, {
    x: W - 36 - reg.widthOfTextAtSize(sub, 9),
    y: headerY - 8,
    size: 9,
    font: reg,
    color: ghost,
  });

  // 3×2 slab grid
  const gridTop = H - 96;
  const gutter = 16;
  const cols = 3;
  const cellW = (W - 36 * 2 - gutter * (cols - 1)) / cols; // = 229.3
  const cellH = 214;
  const imgSize = 112;

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

    // Image (centered top of the cell) or placeholder
    const imgX = x + (cellW - imgSize) / 2;
    const imgY = y + cellH - imgSize - 12;
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
      // cover-fit into the square
      const scale = Math.max(imgSize / embedded.width, imgSize / embedded.height);
      const dw = embedded.width * scale;
      const dh = embedded.height * scale;
      drawClippedImage(page, embedded, imgX, imgY, imgSize, imgSize, dw, dh);
    } else {
      page.drawRectangle({ x: imgX, y: imgY, width: imgSize, height: imgSize, color: rgb(0.06, 0.06, 0.07) });
      const ph = "RPC";
      page.drawText(ph, {
        x: imgX + (imgSize - bold.widthOfTextAtSize(ph, 16)) / 2,
        y: imgY + imgSize / 2 - 6, size: 16, font: bold, color: rgb(0.25, 0.25, 0.28),
      });
    }
    page.drawRectangle({
      x: imgX, y: imgY, width: imgSize, height: imgSize,
      borderColor: tierColor(s.tier), borderWidth: 1.5,
    });

    // Text block
    const pad = 10;
    let ty = imgY - 15;
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
      ty -= 12;
    }

    // Special-serial chips (gold, boxed) — #1 MINT / PERFECT MINT / JERSEY MATCH / 1 OF 1
    const jersey = s.edition_id ? jerseyByKey.get(`${s.collection_id}:${s.edition_id}`) ?? null : null;
    const chips = specialChips(s, jersey);
    if (chips.length > 0) {
      let cx = x + pad;
      for (const chip of chips) {
        const cw = bold.widthOfTextAtSize(chip, 7) + 8;
        if (cx + cw > x + cellW - pad) break;
        page.drawRectangle({ x: cx, y: ty - 3, width: cw, height: 12, borderColor: GOLD, borderWidth: 0.8 });
        page.drawText(chip, { x: cx + 4, y: ty, size: 7, font: bold, color: GOLD });
        cx += cw + 5;
      }
      ty -= 13;
    }

    // Edition badges (Rookie Mint, Rookie Year, Championship Year, …)
    const badges = Array.isArray(s.badges) ? s.badges.filter((b) => typeof b === "string" && b.trim()) : [];
    if (badges.length > 0) {
      const line = truncate(reg, ansi(badges.join("  ·  ")).toUpperCase(), 7, cellW - pad * 2);
      page.drawText(line, { x: x + pad, y: ty, size: 7, font: reg, color: gray });
      ty -= 10;
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

// Draws an image cover-fit inside a square by letting pdf-lib scale it and
// masking the overflow with panel-colored bars (pdf-lib has no clip helper).
function drawClippedImage(
  page: PDFPage,
  img: PDFImage,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  dw: number,
  dh: number,
) {
  const ox = x - (dw - boxW) / 2;
  const oy = y - (dh - boxH) / 2;
  page.drawImage(img, { x: ox, y: oy, width: dw, height: dh });
  const panel = rgb(0.09, 0.09, 0.1);
  // mask overflow (left/right or top/bottom)
  if (dw > boxW) {
    const over = (dw - boxW) / 2;
    page.drawRectangle({ x: ox, y, width: over, height: boxH, color: panel });
    page.drawRectangle({ x: x + boxW, y, width: over, height: boxH, color: panel });
  }
  if (dh > boxH) {
    const over = (dh - boxH) / 2;
    page.drawRectangle({ x, y: oy, width: boxW, height: over, color: panel });
    page.drawRectangle({ x, y: y + boxH, width: boxW, height: over, color: panel });
  }
}
