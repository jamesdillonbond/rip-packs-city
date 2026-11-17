/**
 * app/api/og/default/route.tsx
 *
 * Default branded OG image for Rip Packs City — the card every homepage share,
 * and every page without its own card, unfurls with.
 * 1200×630 PNG rendered via next/og.
 *
 * ⚠ PRERENDERED, NOT RENDERED PER REQUEST (2026-11-16). Measured that afternoon:
 * a cache MISS took 6.1 s (edge cold start + HTTP fetches of both fonts and the
 * logo from our own origin) against 0.25 s for a HIT. iMessage, WhatsApp and X
 * give up on a preview image after a few seconds and show a bare link, and the
 * old 1 h s-maxage + 1 d SWR meant any quiet day ended in a cold render. The card
 * reads no data, so it now renders at BUILD (`revalidate` makes this route
 * static) and is regenerated in the background at most hourly — a crawler is
 * never the request that pays for a render. Node runtime so the fonts AND the
 * logo come off the function's disk (next.config.ts traces both), not over HTTP.
 */

import { ImageResponse } from "next/og";
// Pure static registry — no node APIs.
import { publishedChainsBadge, publishedCollections } from "@/lib/collections";
import { brandFonts, brandFamilies, ogCacheHeaders } from "@/lib/og/brand-fonts";

export const runtime = "nodejs";
// Static + background regeneration. A degraded build-time render (fonts or logo
// missing) is therefore replaced within the hour rather than baked in for the
// whole deploy.
export const dynamic = "force-static";
export const revalidate = 3600;

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com";

// From the registry, not a hand list (2026-10-25): the hardcoded five omitted
// Panini and Candy MLB for weeks after they were published, under a headline
// that said "Flow NFTs" while the footer badge (already registry-driven) said
// FLOW + SOLANA.
const COLLECTIONS = publishedCollections().map((c) => c.label);

const LOGO_FILE = "rip-packs-city-logo.png";

/**
 * The logo as a data URI read from the function's disk, or the public URL when
 * the disk read fails (fail-soft to the old behaviour, never to no logo). The
 * URL path costs satori an HTTP round trip to our own origin per render.
 */
async function logoSrc(): Promise<{ src: string; fromDisk: boolean }> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const b = await readFile(join(process.cwd(), "public", LOGO_FILE));
      // PNG signature check: an empty or truncated file must not reach satori.
      if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return { src: `data:image/png;base64,${b.toString("base64")}`, fromDisk: true };
      }
    } catch {
      // fall through to the URL
    }
  }
  return { src: `${BASE_URL}/${LOGO_FILE}`, fromDisk: false };
}

export async function GET() {
  // Brand typography. `brandFonts` never rejects and validates the bytes before
  // satori sees them, so this cannot break the card.
  const [fonts, logo] = await Promise.all([brandFonts(), logoSrc()]);
  const fam = brandFamilies(fonts);

  const logoUrl = logo.src;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(145deg, #080808 0%, #111128 50%, #0a0a1a 100%)",
          padding: "72px 80px",
          fontFamily: fam.display,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "-150px",
            right: "-150px",
            width: "500px",
            height: "500px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(224,58,47,0.14) 0%, transparent 70%)",
            display: "flex",
          }}
        />

        {/* Logo + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoUrl}
            alt="Rip Packs City"
            width={140}
            height={140}
            style={{ display: "flex" }}
          />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                color: "#FFFFFF",
                fontSize: 68,
                fontWeight: 900,
                letterSpacing: "-0.02em",
                lineHeight: 1,
                display: "flex",
              }}
            >
              RIP PACKS CITY
            </div>
            <div
              style={{
                color: "#E03A2F",
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: "0.3em",
                marginTop: 10,
                display: "flex",
              }}
            >
              COLLECTOR INTELLIGENCE
            </div>
          </div>
        </div>

        {/* Tagline */}
        <div
          style={{
            color: "#E5E7EB",
            fontSize: 52,
            fontWeight: 800,
            lineHeight: 1.15,
            marginTop: 70,
            display: "flex",
            maxWidth: 960,
          }}
        >
          The Intelligence Layer for Digital Collectibles
        </div>

        {/* Collection row */}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginTop: "auto",
            flexWrap: "wrap",
          }}
        >
          {COLLECTIONS.map(function (name) {
            return (
              <div
                key={name}
                style={{
                  color: "#FFFFFF",
                  fontSize: 17,
                  fontWeight: 700,
                  padding: "8px 13px",
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(224,58,47,0.3)",
                  letterSpacing: "0.04em",
                  display: "flex",
                }}
              >
                {name}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 28,
            paddingTop: 20,
            borderTop: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              color: "#9CA3AF",
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "0.08em",
              display: "flex",
            }}
          >
            rippackscity.com
          </div>
          <div
            style={{
              color: "#E03A2F",
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: "0.2em",
              display: "flex",
            }}
          >
            {publishedChainsBadge()}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      ...(fonts ? { fonts } : {}),
      // A card that rendered without its brand fonts gets the short cache, so a
      // fallback render is not what crawlers keep for the next day.
      headers: ogCacheHeaders(!fonts),
    }
  );
}
