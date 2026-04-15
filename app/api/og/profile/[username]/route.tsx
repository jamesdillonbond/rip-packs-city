/**
 * app/api/og/profile/[username]/route.tsx
 *
 * Dynamic OG card for public profile pages (1200×630 PNG).
 * Fetches bio + saved-wallet aggregates + trophies directly via Supabase
 * PostgREST — avoids chaining through our own API on an edge function.
 */

import { ImageResponse } from "next/og";
import { NextRequest } from "next/server";

export const runtime = "edge";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

interface BioRow {
  display_name: string | null;
  tagline: string | null;
  accent_color: string | null;
  avatar_url: string | null;
  favorite_team: string | null;
}

interface WalletRow {
  cached_fmv: number | null;
  cached_moment_count: number | null;
  cached_badges: string[] | null;
}

interface TrophyRow {
  slot: number;
  player_name: string | null;
  thumbnail_url: string | null;
  tier: string | null;
}

function fmtDollars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function tierBorder(tier: string | null | undefined): string {
  const t = (tier ?? "").toUpperCase();
  if (t === "LEGENDARY") return "#F59E0B";
  if (t === "RARE") return "#818CF8";
  return "#6B7280";
}

async function fetchJson<T>(url: string): Promise<T[]> {
  try {
    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
      },
      cache: "no-store",
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return [];
  }
}

function renderFallback() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
          fontFamily: "sans-serif",
          gap: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            fontSize: 48,
            fontWeight: 900,
            letterSpacing: 6,
            textTransform: "uppercase",
          }}
        >
          <span style={{ color: "#fff" }}>RIP PACKS</span>
          <span style={{ color: "#E03A2F" }}>CITY</span>
        </div>
        <div
          style={{
            color: "rgba(255,255,255,0.5)",
            fontSize: 18,
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          rippackscity.com
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  try {
    const { username: rawUsername } = await params;
    const username = decodeURIComponent(rawUsername ?? "").trim();
    if (!username || !SUPABASE_URL || !SERVICE_KEY) return renderFallback();

    const enc = encodeURIComponent(username);
    const [bios, wallets, trophies] = await Promise.all([
      fetchJson<BioRow>(
        `${SUPABASE_URL}/rest/v1/profile_bio?owner_key=eq.${enc}&select=display_name,tagline,accent_color,avatar_url,favorite_team&limit=1`,
      ),
      fetchJson<WalletRow>(
        `${SUPABASE_URL}/rest/v1/saved_wallets?owner_key=eq.${enc}&select=cached_fmv,cached_moment_count,cached_badges&limit=10`,
      ),
      fetchJson<TrophyRow>(
        `${SUPABASE_URL}/rest/v1/trophy_moments?owner_key=eq.${enc}&select=slot,player_name,thumbnail_url,tier&order=slot.asc&limit=6`,
      ),
    ]);

    const bio: BioRow | null = bios[0] ?? null;
    const accent = (bio?.accent_color || "#E03A2F").trim() || "#E03A2F";

    const totalFmv = wallets.reduce(
      (s, w) => s + (Number(w.cached_fmv) || 0),
      0,
    );
    const totalMoments = wallets.reduce(
      (s, w) => s + (Number(w.cached_moment_count) || 0),
      0,
    );

    const thumbTrophies = trophies
      .filter((t) => !!t.thumbnail_url)
      .slice(0, 3);
    const filledTrophyCount = trophies.length;

    const displayName = (bio?.display_name || username).toUpperCase();
    const tagline = bio?.tagline || "";
    const isTeamCaptain = username.toLowerCase() === "jamesdillonbond";
    const initials = username.slice(0, 2).toUpperCase();
    const hasAvatar =
      typeof bio?.avatar_url === "string" &&
      bio.avatar_url.startsWith("https://");

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background:
              "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
            fontFamily: "sans-serif",
            position: "relative",
            padding: "40px 48px",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <span
              style={{
                color: "#fff",
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: 3,
                textTransform: "uppercase",
              }}
            >
              RIP PACKS
            </span>
            <span
              style={{
                color: accent,
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: 3,
                textTransform: "uppercase",
              }}
            >
              CITY
            </span>
          </div>
          <div
            style={{
              width: "100%",
              height: 1,
              background: "rgba(255,255,255,0.08)",
              display: "flex",
              marginBottom: 32,
            }}
          />

          {/* Body row: left content + right trophy fan */}
          <div style={{ display: "flex", flex: 1 }}>
            {/* LEFT */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                width: 720,
                gap: 18,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                {hasAvatar ? (
                  <img
                    src={bio!.avatar_url as string}
                    width={80}
                    height={80}
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: "50%",
                      objectFit: "cover",
                      border: "2px solid " + accent,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: "50%",
                      background: accent + "22",
                      border: "1px solid " + accent,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: accent,
                      fontSize: 28,
                      fontWeight: 800,
                    }}
                  >
                    {initials}
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    maxWidth: 600,
                  }}
                >
                  <div
                    style={{
                      color: "#fff",
                      fontSize: 48,
                      fontWeight: 900,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      lineHeight: 1.05,
                      display: "flex",
                    }}
                  >
                    {displayName}
                  </div>
                  {tagline && (
                    <div
                      style={{
                        color: "rgba(255,255,255,0.5)",
                        fontSize: 18,
                        fontStyle: "italic",
                        display: "flex",
                      }}
                    >
                      {tagline}
                    </div>
                  )}
                  {isTeamCaptain && (
                    <div
                      style={{
                        color: accent,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: 2,
                        marginTop: 4,
                        display: "flex",
                      }}
                    >
                      ✓ PORTLAND TRAIL BLAZERS TEAM CAPTAIN
                    </div>
                  )}
                </div>
              </div>

              {/* Stats row */}
              <div
                style={{
                  display: "flex",
                  gap: 20,
                  marginTop: 28,
                }}
              >
                {[
                  { label: "PORTFOLIO FMV", value: fmtDollars(totalFmv) },
                  {
                    label: "MOMENTS",
                    value:
                      totalMoments > 0 ? totalMoments.toLocaleString() : "—",
                  },
                  { label: "TROPHY CASE", value: filledTrophyCount + " / 6" },
                ].map((s) => (
                  <div
                    key={s.label}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      padding: "16px 20px",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: 10,
                      minWidth: 200,
                    }}
                  >
                    <div
                      style={{
                        color: "#fff",
                        fontSize: 32,
                        fontWeight: 800,
                        lineHeight: 1,
                        display: "flex",
                      }}
                    >
                      {s.value}
                    </div>
                    <div
                      style={{
                        color: "rgba(255,255,255,0.4)",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: 2,
                        textTransform: "uppercase",
                        marginTop: 8,
                        display: "flex",
                      }}
                    >
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* RIGHT: trophy fan */}
            <div
              style={{
                display: "flex",
                position: "relative",
                width: 420,
                height: 380,
              }}
            >
              {thumbTrophies.length > 0 ? (
                thumbTrophies.map((t, i) => {
                  const border = tierBorder(t.tier);
                  const left = i * 40;
                  const top = i * 14;
                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left,
                        top,
                        width: 220,
                        height: 290,
                        borderRadius: 8,
                        overflow: "hidden",
                        border: "2px solid " + border,
                        display: "flex",
                        background: "#111",
                        boxShadow: "0 12px 28px rgba(0,0,0,0.5)",
                      }}
                    >
                      <img
                        src={t.thumbnail_url as string}
                        width={220}
                        height={290}
                        style={{ width: 220, height: 290, objectFit: "cover" }}
                      />
                    </div>
                  );
                })
              ) : (
                <div
                  style={{
                    display: "flex",
                    width: "100%",
                    height: "100%",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "rgba(255,255,255,0.2)",
                    fontSize: 22,
                    fontWeight: 800,
                    letterSpacing: 3,
                    textTransform: "uppercase",
                    border: "1px dashed rgba(255,255,255,0.08)",
                    borderRadius: 12,
                  }}
                >
                  NO TROPHIES PINNED
                </div>
              )}
            </div>
          </div>

          {/* Bottom bar */}
          <div
            style={{
              width: "100%",
              height: 1,
              background: accent + "33",
              display: "flex",
              marginTop: 16,
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
            }}
          >
            <div
              style={{
                color: "rgba(255,255,255,0.4)",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
                display: "flex",
              }}
            >
              COLLECTOR INTELLIGENCE
            </div>
            <div
              style={{
                color: "rgba(255,255,255,0.5)",
                fontSize: 14,
                display: "flex",
              }}
            >
              rippackscity.com
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          "Cache-Control":
            "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch {
    return renderFallback();
  }
}
