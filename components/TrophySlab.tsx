"use client";

import React, { useRef, useState } from "react";
import Link from "next/link";
import { useBadgeTaxonomy, lookupBadge } from "@/lib/badges/useBadgeTaxonomy";
import { seriesLabel, isUnmappedSeriesLabel } from "@/lib/analytics/series-labels";
import { proxyIpfsUrl } from "@/lib/ipfs-media";
import {
  badgeColor,
  tierAccent,
  tierBorder,
  tierGlow,
  tierHoloClass,
  hiResThumb,
} from "@/lib/trophy/slab-style";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type TrophySlabData = {
  id: number;
  slot: number;
  moment_id: string;
  edition_id: string | null;
  player_name: string | null;
  set_name: string | null;
  serial_number: number | null;
  circulation_count: number | null;
  tier: string | null;
  thumbnail_url: string | null;
  video_url: string | null;
  fmv: number | null;
  fmv_confidence: string | null;
  // Phase 2 serial-adjusted FMV (additive #1/perfect-mint premium estimate).
  // Owner surface renders it whenever the RPC returns it. A guide, not a quote.
  // Optional: the public-profile by_username RPC path does NOT return it, so
  // public profiles stay dark until the LiveToken cross-check (same gate as the
  // public moment page).
  serial_fmv?: {
    estimate_usd: number;
    multiplier: number;
    serial_bucket: "first" | "perfect";
    circ_band: string;
    basis: "tier_circ" | "aggregate";
    sample_size: number;
    label: string;
  } | null;
  badges: string[] | null;
  note: string | null;
  collection_id: string;
  collection_slug: string | null;
  collection_display_name: string | null;
  play_description: string | null;
  team_name: string | null;
  series: number | null;
  pinned_at: string | null;
  acquired_price: number | null;
  acquisition_method: string | null;
};

export type TrophySlabProps = {
  slab: TrophySlabData | null;
  slot: number;
  mode: "owner" | "public";
  loading?: boolean;
  onEmptyClick?: (slot: number) => void;
  onRemove?: (slot: number) => void;
};

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

// Solid metallic-silver label fill. The slab visually represents a physical
// product and these colors aren't in the design tokens. Documented exception.
const LABEL_SILVER = "#C8C8C5";
const SCREEN_BLACK = "#050505";

// badgeColor / BADGE_COLORS / tierKey / tierAccent / tierBorder / tierGlow /
// tierHoloClass / hiResThumb moved to @/lib/trophy/slab-style (unit-tested,
// ratcheted). Imported at the top of this file.

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return "$" + Math.round(n).toLocaleString();
  if (n >= 1) return "$" + n.toFixed(0);
  return "$" + n.toFixed(2);
}

// (confidenceColor + confidenceLabel removed 2026-07-11 — no confidence
// signaling on the UI.)

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export default function TrophySlab(props: TrophySlabProps) {
  const { slab, slot, mode, loading, onEmptyClick, onRemove } = props;

  if (loading) return <SlabSkeleton />;
  if (!slab) return <EmptySlab slot={slot} mode={mode} onEmptyClick={onEmptyClick} />;

  return <FilledSlab slab={slab} slot={slot} mode={mode} onRemove={onRemove} />;
}

// ────────────────────────────────────────────────────────────────────────────
// Filled
// ────────────────────────────────────────────────────────────────────────────

function FilledSlab({
  slab,
  slot,
  mode,
  onRemove,
}: {
  slab: TrophySlabData;
  slot: number;
  mode: "owner" | "public";
  onRemove?: (slot: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const accent = tierAccent(slab.tier);
  const border = tierBorder(slab.tier);
  const glow = tierGlow(slab.tier);
  const holo = tierHoloClass(slab.tier);

  const onEnter = () => {
    setHovered(true);
    if (videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  };
  const onLeave = () => {
    setHovered(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
  };

  const badges = (slab.badges ?? []).filter(Boolean);
  // Item C (2026-06-15): resolve each badge title -> artwork via the shared
  // taxonomy (same path as BadgeIcon). Art-backed official badges render as
  // real artwork; no-art derived tags (Finals, Playoffs, …) stay as the
  // compact slab dot — never a text pill on the marquee slab. Art-backed
  // badges sort first so the meaningful trophy badges win the limited slots.
  const badgeTax = useBadgeTaxonomy(badges, slab.collection_id);
  const hasArt = (b: string): boolean => !!lookupBadge(badgeTax, b)?.icon_url;
  const sortedBadges = [...badges].sort(
    (a, b) => (hasArt(a) ? 0 : 1) - (hasArt(b) ? 0 : 1),
  );
  const visibleBadges = sortedBadges.slice(0, sortedBadges.length > 3 ? 2 : 3);
  const extraBadgeCount = sortedBadges.length > 3 ? sortedBadges.length - 2 : 0;

  return (
    <Link
      href={"/moment/" + slab.moment_id}
      style={{ textDecoration: "none", display: "block", color: "inherit" }}
      aria-label={`View ${slab.player_name ?? "moment"}`}
    >
      <div
        className={holo}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        style={{
          position: "relative",
          width: "100%",
          background: "var(--rpc-surface)",
          border: "1px solid " + border,
          borderRadius: 14,
          padding: 10,
          transition: "transform 150ms ease, box-shadow 150ms ease",
          transform: hovered ? "translateY(-2px)" : "translateY(0)",
          boxShadow: hovered ? "0 12px 36px rgba(0,0,0,0.55)" : "none",
        }}
      >
        {/* Owner-only remove button */}
        {mode === "owner" && onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove(slot);
            }}
            aria-label={`Remove slab ${slot}`}
            title="Remove pin"
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              zIndex: 5,
              // 44×44 hit area (mobile min tap target) with a transparent
              // padding ring; the visible ✕ disc stays small via the inner span.
              width: 44,
              height: 44,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
              // ALWAYS rendered, never hover-gated. The slab is a <Link>, so on a
              // touch screen the first tap navigates before any hover state
              // exists — a `display: none` until hover made a pinned trophy
              // impossible to remove from a phone (2026-09-02 onboarding QA,
              // finding #5). Hover now only brightens it.
              display: "flex",
              opacity: hovered ? 1 : 0.72,
              transition: "opacity 120ms ease",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: "rgba(0,0,0,0.6)",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "var(--rpc-text-primary)",
                fontSize: 12,
                lineHeight: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--font-mono)",
              }}
            >
              ✕
            </span>
          </button>
        )}

        {/* Row 1 — metallic label */}
        <SlabLabel
          slab={slab}
          accent={accent}
          badges={visibleBadges}
          badgeTax={badgeTax}
          extraBadgeCount={extraBadgeCount}
          reserveCorner={mode === "owner" && !!onRemove}
        />

        {/* Row 2 — moment screen */}
        <SlabScreen
          slab={slab}
          glow={glow}
          border={border}
          hovered={hovered}
          videoRef={videoRef}
        />

        {/* Row 3 — footer stat strip */}
        <SlabFooter slab={slab} />

        {/* Row 4 — the collector's own caption.
            The ONE field on a trophy the owner writes themselves; everything
            else on this slab is denormalized moment metadata. It has been
            stored and PDF-rendered since the feature shipped while no surface
            displayed it, so a caption someone wrote could only ever be seen by
            exporting a PDF. Rendered in BOTH modes on purpose — the whole
            point of a caption is that visitors read it. */}
        {slab.note && <SlabNote note={slab.note} />}
      </div>
    </Link>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Caption
// ────────────────────────────────────────────────────────────────────────────

function SlabNote({ note }: { note: string }) {
  return (
    <div
      style={{
        marginTop: 8,
        paddingTop: 7,
        borderTop: "1px solid var(--rpc-border)",
        display: "flex",
        alignItems: "flex-start",
        gap: 5,
      }}
    >
      <span
        aria-hidden
        style={{ fontSize: 9, lineHeight: 1.35, color: "var(--rpc-text-ghost)", flexShrink: 0 }}
      >
        &ldquo;
      </span>
      <span
        // Two lines max, then ellipsis. The API caps the caption at 90 chars,
        // but the clamp is kept independently: a slab in a narrow column can
        // run a legal caption past two lines, and an unbounded one would push
        // the slabs in a grid row out of alignment with each other.
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          lineHeight: 1.35,
          color: "var(--rpc-text-secondary)",
          letterSpacing: "0.02em",
          fontStyle: "italic",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {note}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Metallic label
// ────────────────────────────────────────────────────────────────────────────

function SlabLabel({
  slab,
  accent,
  badges,
  badgeTax,
  extraBadgeCount,
  reserveCorner = false,
}: {
  slab: TrophySlabData;
  accent: string;
  badges: string[];
  badgeTax: ReturnType<typeof useBadgeTaxonomy>;
  extraBadgeCount: number;
  /** Owner mode: the always-visible ✕ sits in the top-right corner, so the
   *  serial/tier column moves left of it instead of under it. */
  reserveCorner?: boolean;
}) {
  const tierLabel = (slab.tier ?? "COMMON").toUpperCase();
  const serial =
    slab.serial_number != null
      ? "#" + slab.serial_number + (slab.circulation_count != null ? "/" + slab.circulation_count : "")
      : "";

  // Series name prefixed onto the set name. The shared seriesLabel helper keys
  // Top Shot off the short-form "topshot" token (our slug is long-form), and
  // returns "Misc / Unmapped" for the anomalous TS series=1 — omit the prefix
  // in that case rather than print junk. Non-TS collections fall to "Series N".
  const seriesToken =
    slab.collection_slug === "nba_top_shot" || slab.collection_slug === "topshot"
      ? "topshot"
      : slab.collection_slug;
  const sLabel = seriesLabel(seriesToken, slab.series);
  const seriesPrefix =
    slab.series != null && !isUnmappedSeriesLabel(sLabel) ? sLabel : null;
  const setLine = slab.set_name
    ? seriesPrefix
      ? seriesPrefix + " · " + slab.set_name
      : slab.set_name
    : null;

  return (
    <div
      style={{
        background: LABEL_SILVER,
        borderRadius: 6,
        padding: 8,
        paddingRight: reserveCorner ? 34 : 8,
        display: "flex",
        gap: 7,
        alignItems: "stretch",
        // Min-height (not fixed) so the label never clips the set-name line on
        // narrow/mobile slabs; grows to fit a 2-line name + set instead.
        minHeight: 84,
      }}
    >
      {/* Middle column — player + meta */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 500,
            fontSize: 12,
            color: "#0a0a0a",
            letterSpacing: "0.02em",
            lineHeight: 1.1,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {slab.player_name ?? "Unknown"}
        </div>
        {slab.team_name && (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 8,
              color: "#2a2a2a",
              letterSpacing: "0.05em",
              marginTop: 1,
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {slab.team_name}
          </div>
        )}
        {setLine && (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 8,
              color: "#3a3a3a",
              letterSpacing: "0.03em",
              lineHeight: 1.2,
              marginTop: 2,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {setLine}
          </div>
        )}
      </div>

      {/* Right column — serial + tier */}
      <div
        style={{
          textAlign: "right",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 4,
          minWidth: 50,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          {serial && (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 8,
                color: "#0a0a0a",
                fontWeight: 500,
                letterSpacing: "0.04em",
              }}
            >
              {serial}
            </div>
          )}
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 7,
              color: accent,
              letterSpacing: "0.12em",
              marginTop: 2,
            }}
          >
            {tierLabel}
          </div>
        </div>

        {/* Badges — pinned to the bottom of the right column (via the column's
            space-between), clear of the serial/tier at the top so they never
            overlap the serial the way the old absolute overlay did. */}
        {badges.length > 0 && (
          <div
            aria-hidden
            style={{
              display: "flex",
              gap: 3,
              alignItems: "center",
              justifyContent: "flex-end",
            }}
          >
            {badges.map((b, i) => {
              const meta = lookupBadge(badgeTax, b);
              if (meta?.icon_url) {
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={b + i}
                    src={meta.icon_url}
                    alt={meta.title ?? b}
                    title={meta.title ?? b}
                    width={15}
                    height={15}
                    loading="lazy"
                    style={{
                      width: 15,
                      height: 15,
                      display: "block",
                      objectFit: "contain",
                      filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.45))",
                    }}
                  />
                );
              }
              return (
                <span
                  key={b + i}
                  title={b}
                  style={{
                    display: "inline-block",
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    background: badgeColor(b),
                    border: "1px solid rgba(0,0,0,0.25)",
                  }}
                />
              );
            })}
            {extraBadgeCount > 0 && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 7,
                  color: "#0a0a0a",
                  letterSpacing: "0.05em",
                  marginLeft: 2,
                }}
              >
                +{extraBadgeCount}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Moment screen
// ────────────────────────────────────────────────────────────────────────────

function SlabScreen({
  slab,
  glow,
  border,
  hovered,
  videoRef,
}: {
  slab: TrophySlabData;
  glow: string;
  border: string;
  hovered: boolean;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        position: "relative",
        aspectRatio: "3 / 4",
        background: SCREEN_BLACK,
        border: "1px solid " + border,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {/* Tier ambient glow */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 40%, ${glow} 0%, transparent 60%)`,
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      {/* Media */}
      {slab.video_url ? (
        <video
          ref={videoRef}
          src={proxyIpfsUrl(slab.video_url) ?? undefined}
          poster={hiResThumb(proxyIpfsUrl(slab.thumbnail_url))}
          muted
          loop
          playsInline
          preload="none"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            position: "relative",
            zIndex: 0,
          }}
        />
      ) : slab.thumbnail_url ? (
        <img
          src={hiResThumb(proxyIpfsUrl(slab.thumbnail_url))}
          alt={slab.player_name ?? "Moment"}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            position: "relative",
            zIndex: 0,
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 8,
            color: "rgba(255,255,255,0.15)",
            letterSpacing: "0.2em",
            zIndex: 0,
          }}
        >
          [ MOMENT VIDEO ]
        </div>
      )}

      {/* Subtle hover ring for affordance */}
      {hovered && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            border: "1px solid rgba(255,255,255,0.05)",
            pointerEvents: "none",
            zIndex: 2,
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Footer
// ────────────────────────────────────────────────────────────────────────────

function SlabFooter({ slab }: { slab: TrophySlabData }) {
  const acquired = slab.acquired_price;
  const method = slab.acquisition_method;
  const showAcquired = acquired != null && acquired > 0;
  const showPackPull = !showAcquired && method === "pack_pull";
  // Pinnacle primary mints are admin-minted directly to the wallet; pack-pull vs
  // airdrop is indistinguishable on-chain, so we surface the honest "MINTED" instead.
  const showMinted = !showAcquired && !showPackPull && method === "mint";
  const showRight = showAcquired || showPackPull || showMinted;
  const rightLabel = showPackPull ? "PACK PULL" : "MINTED";

  return (
    <div
      style={{
        marginTop: 8,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0 2px",
      }}
    >
      {/* Left — FMV */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 6,
            color: "var(--rpc-text-ghost)",
            letterSpacing: "0.15em",
          }}
        >
          FMV
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 500,
              fontSize: 13,
              color: "var(--rpc-text-primary)",
              lineHeight: 1.1,
            }}
          >
            {fmtUsd(slab.fmv)}
          </span>
          {/* Tier dot + STALE/ASK/EST label removed 2026-07-11 — no confidence
              signaling anywhere on the UI (Trevor). */}
        </span>
        {/* Phase 2: estimated #1 / perfect-mint premium — a guide, not a quote. */}
        {slab.serial_fmv && (
          <span
            title={`${slab.serial_fmv.label} — ${slab.serial_fmv.multiplier}× edition FMV. Estimate, not a quote.`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              marginTop: 1,
              fontFamily: "var(--font-mono)",
              fontSize: 7,
              color: "var(--rpc-text-muted)",
              letterSpacing: "0.1em",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                border: "1px solid var(--rpc-text-muted)",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            ≈ {fmtUsd(slab.serial_fmv.estimate_usd)}{" "}
            {slab.serial_fmv.serial_bucket === "first" ? "#1 est" : "perfect est"}
          </span>
        )}
      </div>

      {/* Right — acquired / pack pull */}
      {showRight && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", textAlign: "right" }}>
          {showAcquired ? (
            <>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 6,
                  color: "var(--rpc-text-ghost)",
                  letterSpacing: "0.15em",
                }}
              >
                ACQUIRED
              </span>
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 500,
                  fontSize: 11,
                  color: "var(--rpc-text-secondary)",
                  lineHeight: 1.1,
                }}
              >
                {fmtUsd(acquired)}
              </span>
            </>
          ) : (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "var(--rpc-text-muted)",
                letterSpacing: "0.12em",
              }}
            >
              {rightLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Empty slot
// ────────────────────────────────────────────────────────────────────────────

function EmptySlab({
  slot,
  mode,
  onEmptyClick,
}: {
  slot: number;
  mode: "owner" | "public";
  onEmptyClick?: (slot: number) => void;
}) {
  const clickable = mode === "owner" && !!onEmptyClick;
  const handleClick = () => {
    if (clickable) onEmptyClick!(slot);
  };

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleClick();
              }
            }
          : undefined
      }
      style={{
        width: "100%",
        minHeight: 340,
        background: "var(--rpc-surface)",
        border: "1px dashed var(--rpc-border-hover)",
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        cursor: clickable ? "pointer" : "default",
        textAlign: "center",
        transition: "border-color 150ms ease, background 150ms ease",
      }}
    >
      {mode === "owner" && (
        <div
          aria-hidden
          style={{
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: "rgba(224,58,47,0.10)",
            border: "1px solid rgba(224,58,47,0.35)",
            color: "var(--rpc-red)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-display)",
            fontSize: 28,
            fontWeight: 400,
            lineHeight: 1,
          }}
        >
          +
        </div>
      )}
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 500,
          fontSize: 13,
          color: "var(--rpc-text-primary)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {mode === "owner" ? "PIN A MOMENT" : "EMPTY SLAB"}
      </div>
      {mode === "owner" && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 8,
            color: "var(--rpc-text-muted)",
            letterSpacing: "0.1em",
            lineHeight: 1.4,
            maxWidth: 200,
          }}
        >
          SLAB SLOT {slot} · EMPTY · TAP TO CHOOSE FROM YOUR COLLECTION
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Loading skeleton
// ────────────────────────────────────────────────────────────────────────────

function SlabSkeleton() {
  return (
    <div
      style={{
        width: "100%",
        minHeight: 340,
        background: "var(--rpc-surface)",
        border: "1px solid var(--rpc-border)",
        borderRadius: 14,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div className="rpc-skeleton" style={{ height: 56, borderRadius: 6 }} />
      <div className="rpc-skeleton" style={{ flex: 1, minHeight: 220, borderRadius: 6 }} />
      <div className="rpc-skeleton" style={{ height: 28, borderRadius: 4 }} />
    </div>
  );
}
