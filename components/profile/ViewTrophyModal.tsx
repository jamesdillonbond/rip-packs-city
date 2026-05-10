"use client";

// ViewTrophyModal — popup detail view for a pinned trophy moment.
// Shared by /profile (owner view) and /profile/[username] (public view) so
// both surfaces show the same moment-detail card.
//
// Media: prefer the per-collection animated CDN URL derived from
// (collection_id, moment_id, edition_id). If we can't derive a video for the
// collection (Pinnacle, or missing input fields) we render the still
// thumbnail. The trophy_moments.video_url column wins over the derived URL
// when populated — that lets ops paste a hand-curated URL for one-offs
// without changing the resolver.
//
// Deeplinks: three text-style links below the media — RPC moment page,
// Top Shot moment page (TS only), and Flowty asset page. External links
// open in a new tab with rel noopener noreferrer.

import { useEffect } from "react";
import Link from "next/link";
import { monoFont, condensedFont, fmtDollars, TrophyMoment, TIER_COLORS } from "./_shared";
import {
  deriveMomentVideoUrl,
  rpcMomentUrl,
  topShotMomentUrl,
  flowtyAssetUrl,
} from "@/lib/media/momentVideoUrl";
import { track } from "@/lib/telemetry/track";

interface ViewTrophyModalProps {
  trophy: TrophyMoment | null;
  onClose: () => void;
  /** Show the slot label badge (🥇🥈🥉⭐⭐⭐) — owner profile passes true. */
  showSlotBadge?: boolean;
}

const SLOT_LABELS = ["", "🥇", "🥈", "🥉", "⭐", "⭐", "⭐"];

export default function ViewTrophyModal({ trophy, onClose, showSlotBadge = true }: ViewTrophyModalProps) {
  useEffect(() => {
    if (!trophy) return;
    track("trophy-modal-open", {
      slot: trophy.slot,
      collection_id: trophy.collection_id ?? null,
      tier: trophy.tier ?? null,
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trophy, onClose]);

  if (!trophy) return null;

  const tierKey = (trophy.tier ?? "").trim();
  const tierColor =
    TIER_COLORS[tierKey] ??
    TIER_COLORS[tierKey.charAt(0).toUpperCase() + tierKey.slice(1).toLowerCase()] ??
    "#9CA3AF";

  const mediaInputs = {
    collectionUuid: trophy.collection_id ?? null,
    momentId: trophy.moment_id ?? null,
    editionId: trophy.edition_id ?? null,
    thumbnailUrl: trophy.thumbnail_url ?? null,
  };
  const derivedVideo = deriveMomentVideoUrl(mediaInputs);
  const videoUrl = trophy.video_url ?? derivedVideo;
  const hasVideo = !!videoUrl;

  const rpcUrl = rpcMomentUrl(mediaInputs);
  const tsUrl = topShotMomentUrl(mediaInputs);
  const flowtyUrl = flowtyAssetUrl(mediaInputs);

  const slotEmoji = showSlotBadge ? SLOT_LABELS[trophy.slot] ?? "" : "";

  const badges = (trophy.badges ?? []).filter(Boolean);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 20,
        backdropFilter: "blur(4px)",
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0a0a0a",
          border: `1px solid ${tierColor}55`,
          borderRadius: 12,
          maxWidth: 520,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: `0 0 60px ${tierColor}22`,
          position: "relative",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            zIndex: 2,
            background: "rgba(0,0,0,0.7)",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "#fff",
            width: 30,
            height: 30,
            borderRadius: "50%",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ×
        </button>

        {/* Media */}
        <div
          style={{
            position: "relative",
            aspectRatio: "1 / 1",
            background: "#111",
            borderRadius: "12px 12px 0 0",
            overflow: "hidden",
          }}
        >
          {hasVideo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={videoUrl ?? undefined}
              poster={trophy.thumbnail_url ?? undefined}
              autoPlay
              loop
              muted
              playsInline
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : trophy.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={trophy.thumbnail_url}
              alt={trophy.player_name ?? "Trophy moment"}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 60,
                opacity: 0.2,
              }}
            >
              🏆
            </div>
          )}
          {slotEmoji && (
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 12,
                fontSize: 24,
                filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.8))",
              }}
            >
              {slotEmoji}
            </div>
          )}
          {trophy.tier && (
            <div
              style={{
                position: "absolute",
                bottom: 12,
                left: 12,
                background: "rgba(0,0,0,0.75)",
                border: `1px solid ${tierColor}`,
                color: tierColor,
                fontFamily: monoFont,
                fontSize: 10,
                padding: "3px 8px",
                borderRadius: 4,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                fontWeight: 700,
              }}
            >
              {trophy.tier}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: "18px 20px 20px" }}>
          <div
            style={{
              fontFamily: condensedFont,
              fontWeight: 800,
              fontSize: 22,
              color: "#fff",
              letterSpacing: "0.02em",
              lineHeight: 1.1,
            }}
          >
            {trophy.player_name ?? "Unknown"}
          </div>
          {trophy.set_name && (
            <div
              style={{
                marginTop: 4,
                fontFamily: monoFont,
                fontSize: 11,
                color: "rgba(255,255,255,0.6)",
                letterSpacing: "0.04em",
              }}
            >
              {trophy.set_name}
            </div>
          )}

          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              fontFamily: monoFont,
              fontSize: 11,
            }}
          >
            <Stat
              label="Serial"
              value={
                trophy.serial_number != null
                  ? `#${trophy.serial_number}${trophy.circulation_count != null ? ` / ${trophy.circulation_count}` : ""}`
                  : "—"
              }
            />
            <Stat
              label="FMV"
              value={trophy.fmv != null ? fmtDollars(Number(trophy.fmv)) : "—"}
              valueColor="#34D399"
            />
          </div>

          {badges.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  fontFamily: monoFont,
                  fontSize: 9,
                  color: "rgba(255,255,255,0.4)",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Badges
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {badges.map((b, i) => (
                  <span
                    key={i}
                    style={{
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 4,
                      padding: "3px 8px",
                      fontFamily: monoFont,
                      fontSize: 10,
                      color: "rgba(255,255,255,0.85)",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {b}
                  </span>
                ))}
              </div>
            </div>
          )}

          {trophy.note && (
            <div
              style={{
                marginTop: 14,
                padding: "10px 12px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 6,
                fontFamily: monoFont,
                fontSize: 11,
                color: "rgba(255,255,255,0.85)",
                fontStyle: "italic",
                lineHeight: 1.5,
              }}
            >
              &ldquo;{trophy.note}&rdquo;
            </div>
          )}

          {(rpcUrl || tsUrl || flowtyUrl) && (
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: "1px solid rgba(255,255,255,0.08)",
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 14px",
                fontFamily: monoFont,
                fontSize: 10,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
              }}
            >
              {rpcUrl && (
                <Link
                  href={rpcUrl}
                  onClick={onClose}
                  style={{
                    color: "#E03A2F",
                    textDecoration: "none",
                    fontWeight: 700,
                  }}
                >
                  View on RPC →
                </Link>
              )}
              {tsUrl && (
                <a
                  href={tsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "rgba(255,255,255,0.85)",
                    textDecoration: "none",
                    fontWeight: 700,
                  }}
                >
                  View on Top Shot ↗
                </a>
              )}
              {flowtyUrl && (
                <a
                  href={flowtyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "rgba(255,255,255,0.85)",
                    textDecoration: "none",
                    fontWeight: 700,
                  }}
                >
                  View on Flowty ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          color: "rgba(255,255,255,0.4)",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontWeight: 700, color: valueColor ?? "#fff", fontSize: 13 }}>{value}</div>
    </div>
  );
}
