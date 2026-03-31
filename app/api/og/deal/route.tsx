/**
 * app/api/og/deal/route.tsx
 *
 * Dynamic OG image generator for Sniper Deal tweets.
 * Uses next/og (built into Next.js App Router — no install needed).
 * Returns a 1200×630 PNG with branded RPC styling.
 *
 * Usage:
 *   GET /api/og/deal?player=LaMelo+Ball&tier=Rare&serial=247&listed=12&fmv=31&pct=62
 *
 * The sniper bot calls this URL, downloads the PNG, uploads to X as media.
 * Images are edge-cached after first generation — subsequent identical requests are instant.
 */

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const player = sp.get("player") || "Unknown Player";
  const tier = sp.get("tier") || "Common";
  const serial = sp.get("serial") || "";
  const listed = sp.get("listed") || "0";
  const fmv = sp.get("fmv") || "0";
  const pct = sp.get("pct") || "0";
  const badge = sp.get("badge") || "";
  const source = sp.get("source") || "topshot"; // 'topshot' | 'flowty'

  // Tier color mapping
  const tierColor =
    tier.toLowerCase() === "legendary"
      ? "#FFD700"
      : tier.toLowerCase() === "rare"
        ? "#A855F7"
        : tier.toLowerCase() === "fandom"
          ? "#3B82F6"
          : "#9CA3AF";

  // Source badge
  const sourceLabel = source === "flowty" ? "FLOWTY" : "TOP SHOT";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "linear-gradient(145deg, #0a0a1a 0%, #111128 50%, #0d0d20 100%)",
          padding: "48px 56px",
          fontFamily: "sans-serif",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Background accent glow */}
        <div
          style={{
            position: "absolute",
            top: "-100px",
            right: "-100px",
            width: "400px",
            height: "400px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 70%)",
            display: "flex",
          }}
        />

        {/* Header row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                fontSize: "28px",
                lineHeight: 1,
                display: "flex",
              }}
            >
              🎯
            </div>
            <div
              style={{
                color: "#FF6B35",
                fontSize: "22px",
                fontWeight: 800,
                letterSpacing: "2px",
                display: "flex",
              }}
            >
              SNIPER ALERT
            </div>
          </div>
          <div
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "center",
            }}
          >
            <div
              style={{
                color: source === "flowty" ? "#00D4AA" : "#FF6B35",
                fontSize: "12px",
                fontWeight: 700,
                padding: "4px 10px",
                borderRadius: "4px",
                background:
                  source === "flowty"
                    ? "rgba(0,212,170,0.1)"
                    : "rgba(255,107,53,0.1)",
                border: `1px solid ${source === "flowty" ? "rgba(0,212,170,0.2)" : "rgba(255,107,53,0.2)"}`,
                letterSpacing: "1px",
                display: "flex",
              }}
            >
              {sourceLabel}
            </div>
          </div>
        </div>

        {/* Player name */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: "24px",
            flex: 1,
          }}
        >
          <div
            style={{
              color: "#FFFFFF",
              fontSize: "52px",
              fontWeight: 800,
              lineHeight: 1.1,
              display: "flex",
            }}
          >
            {player}
          </div>

          {/* Tier + Serial + Badge row */}
          <div
            style={{
              display: "flex",
              gap: "10px",
              marginTop: "16px",
              alignItems: "center",
            }}
          >
            <div
              style={{
                color: tierColor,
                fontSize: "18px",
                fontWeight: 700,
                padding: "5px 14px",
                borderRadius: "6px",
                background: "rgba(255,255,255,0.04)",
                border: `1px solid ${tierColor}33`,
                display: "flex",
              }}
            >
              {tier}
            </div>
            {serial && (
              <div
                style={{
                  color: "#6B7280",
                  fontSize: "18px",
                  fontWeight: 500,
                  padding: "5px 14px",
                  display: "flex",
                }}
              >
                #{serial}
              </div>
            )}
            {badge && (
              <div
                style={{
                  color: "#00D4AA",
                  fontSize: "16px",
                  fontWeight: 600,
                  padding: "5px 14px",
                  borderRadius: "6px",
                  background: "rgba(0,212,170,0.08)",
                  border: "1px solid rgba(0,212,170,0.15)",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                ⭐ {badge}
              </div>
            )}
          </div>
        </div>

        {/* Price comparison row */}
        <div
          style={{
            display: "flex",
            gap: "40px",
            alignItems: "flex-end",
            marginTop: "auto",
          }}
        >
          {/* Listed price */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                color: "#6B7280",
                fontSize: "12px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "2px",
                marginBottom: "4px",
                display: "flex",
              }}
            >
              LISTED
            </div>
            <div
              style={{
                color: "#00D4AA",
                fontSize: "52px",
                fontWeight: 800,
                lineHeight: 1,
                display: "flex",
              }}
            >
              ${listed}
            </div>
          </div>

          {/* FMV */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                color: "#6B7280",
                fontSize: "12px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "2px",
                marginBottom: "4px",
                display: "flex",
              }}
            >
              FMV
            </div>
            <div
              style={{
                color: "#6B7280",
                fontSize: "36px",
                fontWeight: 600,
                lineHeight: 1,
                textDecoration: "line-through",
                display: "flex",
              }}
            >
              ${fmv}
            </div>
          </div>

          {/* Percentage below badge */}
          <div
            style={{
              color: "#FF4444",
              fontSize: "28px",
              fontWeight: 800,
              padding: "10px 20px",
              borderRadius: "8px",
              background: "rgba(255,68,68,0.08)",
              border: "1px solid rgba(255,68,68,0.15)",
              display: "flex",
              alignItems: "center",
            }}
          >
            {pct}% BELOW
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: "24px",
            paddingTop: "16px",
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div
            style={{
              color: "#4B5563",
              fontSize: "14px",
              fontWeight: 500,
              display: "flex",
            }}
          >
            rip-packs-city.vercel.app/sniper
          </div>
          <div
            style={{
              color: "#FF6B35",
              fontSize: "14px",
              fontWeight: 700,
              letterSpacing: "1px",
              display: "flex",
            }}
          >
            RIP PACKS CITY
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