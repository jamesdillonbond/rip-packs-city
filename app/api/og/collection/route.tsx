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

export const runtime = "edge";

const CHAIN_LABELS: Record<string, string> = {
  flow: "FLOW",
  evm: "EVM",
  panini: "PANINI CHAIN",
  candy: "ROOT NETWORK",
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
  const sp = req.nextUrl.searchParams;
  const id = sp.get("id") || "";
  const page = sp.get("page") || "";

  const collection = getCollection(id);

  const label = collection?.label ?? "Rip Packs City";
  const icon = collection?.icon ?? "🎴"; // 🎴
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
          fontFamily: "sans-serif",
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
          <div
            style={{
              fontSize: "140px",
              lineHeight: 1,
              marginBottom: "16px",
              display: "flex",
            }}
          >
            {icon}
          </div>
          <div
            style={{
              color: "#FFFFFF",
              fontSize: "76px",
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
    }
  );
}
