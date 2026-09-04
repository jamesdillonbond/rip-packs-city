"use client";

// components/profile/AvatarMomentPicker.tsx
//
// Pick your avatar from a Moment you already own.
//
// WHY THIS, RATHER THAN MORE URL VALIDATION (2026-08-16). Asking a collector to
// produce an image URL is asking them to do a job browsers make hard: the
// obvious thing to copy is the PAGE address, which is valid, points at HTML, and
// fails silently. A real collector pasted an OpenSea item page and got the
// monogram. We can warn about that (lib/profile/avatar-url.ts) — but the better
// answer on a collectibles platform is not to ask for a URL at all. We already
// know every Moment they own, and we already have its art: measured 2026-08-16,
// image coverage across the five largest collector wallets is 81.9%–100%.
//
// ⚠ IT WRITES THE SAME `avatar_url` FIELD, DELIBERATELY. No new column, no new
// save path, no second source of truth: the picked URL flows through exactly the
// machinery a typed one does — the RPC-logo default when cleared, the live
// preview, the load-failure check, and the OG card's https gate. A separate
// "avatar_moment_id" would have doubled every one of those.
//
// Reuses `/api/profile/top-moments` (the trophy picker's source), which returns
// a COALESCE'd thumbnail chain — wmc.image_url → editions.thumbnail_url → … —
// so it is already hardened against the NULL-image case that a raw wmc read hits.

import { useEffect, useState } from "react";
import { useModalA11y } from "@/lib/hooks/useModalA11y";

const MONO = "var(--font-mono)";
const DISPLAY = "var(--font-display)";

/** How many owned Moments to offer, highest FMV first. */
export const AVATAR_PICKER_LIMIT = 48;

export type PickableMoment = {
  id?: string;
  player_name: string | null;
  character_name?: string | null;
  set_name: string | null;
  serial_number: number | null;
  image_url: string | null;
};

/** The label under a tile. Pinnacle has no player, so fall back to character. */
export function momentLabel(m: PickableMoment): string {
  return (m.player_name || m.character_name || m.set_name || "Moment").trim();
}

export default function AvatarMomentPicker({
  onPick,
  onClose,
}: {
  onPick: (imageUrl: string) => void;
  onClose: () => void;
}) {
  const [moments, setMoments] = useState<PickableMoment[] | null>(null);
  /**
   * ⚠ SEPARATE FROM `moments === null`. A failed read must never render "you
   * own no Moments" — that is a claim about the collector's own holdings
   * manufactured from our outage, and it is the single most repeated defect
   * class in this repo. `null` means "still loading", `[]` means "we asked and
   * there are none", `loadFailed` means "we could not ask".
   */
  const [loadFailed, setLoadFailed] = useState(false);
  // Mounted only while open: Escape closes, Tab is trapped, focus is restored.
  const contentRef = useModalA11y<HTMLDivElement>(true, onClose);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/profile/top-moments?limit=${AVATAR_PICKER_LIMIT}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setMoments(Array.isArray(d?.moments) ? d.moments : []);
      })
      .catch(() => {
        // Covers BOTH a non-2xx and a thrown fetch. Without the throw above,
        // a 500 would have resolved into the empty-state path.
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const withArt = (moments ?? []).filter((m) => !!m.image_url);

  return (
    <div
      data-testid="avatar-moment-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Choose an avatar from your Moments"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        ref={contentRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--rpc-surface)",
          border: "1px solid var(--rpc-border)",
          borderRadius: 10,
          maxWidth: 620,
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
          padding: 18,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 16, letterSpacing: "0.04em", color: "var(--rpc-text-primary)" }}>
            YOUR MOMENTS
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "var(--rpc-text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loadFailed ? (
          <div data-testid="avatar-picker-failed" style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-warning)", lineHeight: 1.6 }}>
            Couldn&rsquo;t load your Moments just now — this is a problem on our
            side, not a sign you don&rsquo;t own any. Close this and try again,
            or paste an image URL instead.
          </div>
        ) : moments === null ? (
          <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading your Moments…</div>
        ) : withArt.length === 0 ? (
          <div data-testid="avatar-picker-empty" style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
            No Moments with artwork found on your saved wallets yet. Add or
            verify a wallet from your dashboard, or paste an image URL instead.
          </div>
        ) : (
          <>
            <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--rpc-text-ghost)", marginBottom: 10, letterSpacing: "0.08em" }}>
              Your {withArt.length} highest-value Moments. Pick one to use as your avatar.
            </div>
            <div
              className="rpc-avatar-picker-grid"
              style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10 }}
            >
              {withArt.map((m, i) => (
                <button
                  key={m.id ?? `m-${i}`}
                  type="button"
                  data-testid="avatar-picker-tile"
                  title={momentLabel(m)}
                  onClick={() => onPick(m.image_url as string)}
                  style={{
                    background: "transparent",
                    border: "1px solid var(--rpc-border)",
                    borderRadius: 8,
                    padding: 6,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    alignItems: "center",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={m.image_url as string}
                    alt={momentLabel(m)}
                    style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 6 }}
                  />
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 8,
                      color: "var(--rpc-text-muted)",
                      textAlign: "center",
                      lineHeight: 1.3,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {momentLabel(m)}
                    {m.serial_number != null ? ` #${m.serial_number}` : ""}
                  </span>
                </button>
              ))}
            </div>
            <style>{`
              @media (max-width: 520px) {
                .rpc-avatar-picker-grid { grid-template-columns: repeat(3, minmax(0,1fr)) !important; }
              }
            `}</style>
          </>
        )}
      </div>
    </div>
  );
}
