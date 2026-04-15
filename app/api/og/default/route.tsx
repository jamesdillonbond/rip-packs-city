/**
 * app/api/og/default/route.tsx
 *
 * Default branded OG image for Rip Packs City.
 * 1200×630 PNG rendered via next/og at the edge.
 */

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://rip-packs-city.vercel.app";

const COLLECTIONS = [
  "NBA Top Shot",
  "NFL All Day",
  "LaLiga Golazos",
  "Disney Pinnacle",
  "UFC Strike",
];

export async function GET(_req: NextRequest) {
  const logoUrl = `${BASE_URL}/rip-packs-city-logo.png`;

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
          fontFamily: "sans-serif",
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
          Collector Intelligence for Flow NFTs
        </div>

        {/* Collection row */}
        <div
          style={{
            display: "flex",
            gap: 14,
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
                  fontSize: 20,
                  fontWeight: 700,
                  padding: "10px 18px",
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
            rip-packs-city.vercel.app
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
            BUILT ON FLOW
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
