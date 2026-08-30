/**
 * app/api/og/collection/route.tsx
 *
 * Dynamic OG image generator for per-collection share cards.
 * Returns a 1200×630 PNG branded with the collection's icon, label,
 * accent color, and chain pill — plus an optional page-specific tagline.
 *
 * Usage:
 *   GET /api/og/collection?id=disney-pinnacle&page=sniper
 *   GET /api/og/collection?id=nba-top-shot
 *   GET /api/og/collection?id=invalid          → fallback card
 *
 * Modeled on app/api/og/deal/route.tsx — every flex container declares
 * display:"flex" because next/og requires it on every node.
 */

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";
import { getCollection } from "@/lib/collections";
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts";

export const runtime = "edge";

// Keyed by the registry's roadmap `chain` field. NOTE: the authoritative chain
// is `dbChain` (see lib/collections.ts) — these are brand/roadmap labels. `candy`
// migrated OFF Futureverse/Root Network to Solana in mid-2026 (dbChain "solana"),
// so its label is SOLANA, not the dead "ROOT NETWORK".
const CHAIN_LABELS: Record<string, string> = {
  flow: "FLOW",
  evm: "EVM",
  panini: "PANINI CHAIN",
  candy: "SOLANA",
  rwa: "MULTI-CHAIN",
};

const PAGE_TAGLINES: Record<string, string> = {
  overview: "LIVE MARKET OVERVIEW",
  collection: "WALLET ANALYTICS & FMV",
  packs: "PACK EV CALCULATOR",
  sniper: "REAL-TIME DEALS BELOW FMV",
  badges: "BADGE & RARE-SERIAL FILTERS",
  sets: "SET COMPLETION TRACKER",
  vault: "VAULTED RWA TRACKER",
};

const FALLBACK_TAGLINE = "COLLECTOR INTELLIGENCE PLATFORM";

export async function GET(req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  const sp = req.nextUrl.searchParams;
  const id = sp.get("id") || "";
  const page = sp.get("page") || "";

  const collection = getCollection(id);

  const label = collection?.label ?? "Rip Packs City";
  // ⚠ `collection.icon` USED TO BE THE HERO OF THIS CARD, AT 140px, AND IT WAS
  // THE ONE CDN DEPENDENCY NO SOURCE SCAN COULD EVER HAVE FOUND. Every icon in
  // the registry is an emoji (🏀 🏈 ✨ ⚽ 🥊 🃏 ⚾ 🏅), so next/og fetched an SVG
  // from cdn.jsdelivr.net at RENDER time — through DATA, not through a literal
  // in this file. A guard that greps OG routes for emoji sees the "🎴" fallback
  // and nothing else; the actual dependency arrived from lib/collections.ts.
  // The registry field is untouched (the mobile collections sheet still renders
  // it in a browser, where an emoji costs nothing) — this CARD no longer asks
  // for a glyph it cannot draw. See lib/og/marks.tsx for the measurement.
  const accent = collection?.accent ?? "#E03A2F";
  const sport = collection?.sport ?? "Multi-Sport";
  const partner = collection?.partner ?? "RPC";
  const chain = collection?.chain ?? "flow";

  const chainLabel = CHAIN_LABELS[chain] ?? chain.toUpperCase();
  const tagline = PAGE_TAGLINES[page] ?? FALLBACK_TAGLINE;
  const url = collection ? `rippackscity.com/${collection.id}` : "rippackscity.com";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "linear-gradient(145deg, #0a0a1a 0%, #111128 50%, #0d0d20 100%)",
          padding: "56px",
          fontFamily: fam.display,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Glow accents */}
        <div
          style={{
            position: "absolute",
            top: "-150px",
            right: "-150px",
            width: "500px",
            height: "500px",
            borderRadius: "50%",
            background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)`,
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: "-100px",
            left: "-100px",
            width: "400px",
            height: "400px",
            borderRadius: "50%",
            background: `radial-gradient(circle, ${accent}15 0%, transparent 70%)`,
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "1px",
            background: `linear-gradient(90deg, transparent 0%, ${accent}55 50%, transparent 100%)`,
            display: "flex",
          }}
        />

        {/* Header row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              color: "#E03A2F",
              fontSize: "18px",
              fontWeight: 800,
              letterSpacing: "3px",
              display: "flex",
            }}
          >
            RIP PACKS CITY
          </div>
          <div
            style={{
              color: accent,
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "2px",
              padding: "6px 14px",
              borderRadius: "4px",
              background: `${accent}18`,
              border: `1px solid ${accent}44`,
              display: "flex",
            }}
          >
            {chainLabel}
          </div>
        </div>

        {/* Hero block */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
          }}
        >
          {/* The accent rule replaces the 140px emoji as the hero's anchor.
              It is the collection's own colour, it needs no font and no
              network, and it hands the vertical space the cartoon was using
              back to the thing a 1200x630 card is actually read for in a
              timeline: the NAME. 76px -> 96px is the visible half of this
              change; the invisible half is that the card no longer waits on
              somebody else's CDN before a crawler can see it. */}
          <div
            style={{
              width: "160px",
              height: "10px",
              background: accent,
              marginBottom: "34px",
              display: "flex",
            }}
          />
          <div
            style={{
              color: "#FFFFFF",
              fontSize: "96px",
              fontWeight: 800,
              lineHeight: 1,
              display: "flex",
            }}
          >
            {label}
          </div>
          <div
            style={{
              color: "#6B7280",
              fontSize: "18px",
              fontWeight: 600,
              letterSpacing: "2px",
              textTransform: "uppercase",
              marginTop: "20px",
              display: "flex",
            }}
          >
            {`${sport} · ${partner}`}
          </div>
        </div>

        {/* Footer row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: "20px",
            borderTop: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <div
            style={{
              color: accent,
              fontSize: "16px",
              fontWeight: 700,
              letterSpacing: "2px",
              display: "flex",
            }}
          >
            {tagline}
          </div>
          <div
            style={{
              color: "#6B7280",
              fontSize: "14px",
              fontWeight: 600,
              display: "flex",
            }}
          >
            {url}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      ...(fonts ? { fonts } : {}),
      headers: OG_CACHE_HEADERS,
    }
  );
}
