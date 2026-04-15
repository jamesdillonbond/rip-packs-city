"use client";

import { useEffect, useRef, useState } from "react";

const TIER_COLORS: Record<string, string> = {
  COMMON: "#9ca3af",
  UNCOMMON: "#14b8a6",
  FANDOM: "#60a5fa",
  RARE: "#38bdf8",
  LEGENDARY: "#fbbf24",
  ULTIMATE: "#c084fc",
};

const BADGE_ICONS: Record<string, string> = {
  "Rookie Year": "⭐",
  "Rookie Premiere": "🌟",
  "Top Shot Debut": "✨",
  "Rookie of the Year": "🏆",
  "Rookie Mint": "💎",
  "Championship Year": "👑",
  "3 Star Rookie": "⭐⭐⭐",
};

export interface MomentDetailModalProps {
  moment: {
    flowId?: string | null;
    playerName: string;
    setName?: string;
    tier?: string | null;
    serialNumber?: number | null;
    mintSize?: number | null;
    fmv?: number | null;
    dealRating?: number | null;
    listingPrice?: number | null;
    marketConfidence?: string | null;
    badgeTitles?: string[];
    officialBadges?: string[];
    imageUrlPrefix?: string | null;
    buyUrl?: string | null;
  } | null;
  onClose: () => void;
}

function getImageUrl(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  const resizePrefix = prefix.replace(
    "https://assets.nbatopshot.com/editions/",
    "https://assets.nbatopshot.com/resize/editions/"
  );
  return `${resizePrefix}Hero_2880_2880_Transparent.png?format=webp&quality=80&width=600`;
}

function getVideoUrl(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  return `${prefix}Animated_1080_1080_Black.mp4`;
}

export default function MomentDetailModal({ moment, onClose }: MomentDetailModalProps) {
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!moment) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moment, onClose]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hovered) v.play().catch(() => {});
    else {
      v.pause();
      v.currentTime = 0;
    }
  }, [hovered]);

  if (!moment) return null;

  const tierKey = (moment.tier || "").toUpperCase();
  const tierColor = TIER_COLORS[tierKey] || "#9ca3af";
  const imgUrl =
    getImageUrl(moment.imageUrlPrefix) ||
    (moment.flowId ? `/api/moment-thumbnail?flowId=${encodeURIComponent(moment.flowId)}&width=600` : null);
  const videoUrl = getVideoUrl(moment.imageUrlPrefix);
  const dealRating = typeof moment.dealRating === "number" ? Math.max(0, Math.min(1, moment.dealRating)) : null;
  const dealColor =
    dealRating === null ? "#6b7280" : dealRating >= 0.7 ? "#22c55e" : dealRating >= 0.4 ? "#eab308" : "#ef4444";

  const badges = [...(moment.badgeTitles || []), ...(moment.officialBadges || [])];

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        animation: "fadeIn 0.15s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--rpc-surface, #0f0f0f)",
          border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
          borderRadius: 10,
          maxWidth: 640,
          width: "100%",
          maxHeight: "90vh",
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          color: "#fff",
        }}
      >
        <div
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            position: "relative",
            background: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 320,
          }}
        >
          {imgUrl && (
            <img
              src={imgUrl}
              alt={moment.playerName}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                opacity: hovered && videoUrl ? 0 : 1,
                transition: "opacity 0.15s",
              }}
            />
          )}
          {videoUrl && (
            <video
              ref={videoRef}
              src={videoUrl}
              muted
              loop
              playsInline
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                opacity: hovered ? 1 : 0,
                transition: "opacity 0.15s",
              }}
            />
          )}
        </div>

        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          <div
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 900,
              fontSize: 26,
              lineHeight: 1.1,
              textTransform: "uppercase",
            }}
          >
            {moment.playerName}
          </div>
          {moment.setName && (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>{moment.setName}</div>
          )}

          {moment.tier && (
            <div>
              <span
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  border: `1px solid ${tierColor}`,
                  color: tierColor,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  borderRadius: 3,
                  textTransform: "uppercase",
                }}
              >
                {moment.tier}
              </span>
            </div>
          )}

          {(moment.serialNumber != null || moment.mintSize != null) && (
            <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13 }}>
              #{moment.serialNumber ?? "?"}
              {moment.mintSize != null && <span style={{ color: "rgba(255,255,255,0.45)" }}> / {moment.mintSize}</span>}
            </div>
          )}

          {moment.fmv != null && (
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em" }}>FMV</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#22c55e", fontFamily: "'Share Tech Mono', monospace" }}>
                ${moment.fmv.toFixed(2)}
              </div>
            </div>
          )}

          {moment.listingPrice != null && (
            <div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em" }}>LIST PRICE</div>
              <div style={{ fontSize: 16, fontFamily: "'Share Tech Mono', monospace" }}>
                ${moment.listingPrice.toFixed(2)}
              </div>
            </div>
          )}

          {dealRating !== null && (
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.5)",
                  letterSpacing: "0.1em",
                  marginBottom: 4,
                }}
              >
                DEAL RATING
              </div>
              <div
                style={{
                  height: 6,
                  background: "rgba(255,255,255,0.08)",
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${dealRating * 100}%`,
                    height: "100%",
                    background: dealColor,
                    transition: "width 0.2s",
                  }}
                />
              </div>
            </div>
          )}

          {moment.marketConfidence && (
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em" }}>
              CONFIDENCE: <span style={{ color: "#fff" }}>{moment.marketConfidence.toUpperCase()}</span>
            </div>
          )}

          {badges.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {badges.map((b) => (
                <span
                  key={b}
                  title={b}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 3,
                  }}
                >
                  <span style={{ marginRight: 4 }}>{BADGE_ICONS[b] || "●"}</span>
                  {b}
                </span>
              ))}
            </div>
          )}

          {moment.buyUrl && (
            <a
              href={moment.buyUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginTop: "auto",
                display: "inline-block",
                textAlign: "center",
                background: "#E03A2F",
                color: "#fff",
                padding: "10px 16px",
                borderRadius: 4,
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 800,
                fontSize: 13,
                letterSpacing: "0.12em",
                textDecoration: "none",
                textTransform: "uppercase",
              }}
            >
              Buy on Flowty →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
