"use client";

// components/profile/ProfileHeaderPreview.tsx
//
// A live rendering of the collector's public profile header, for /profile/edit.
//
// WHY. Until 2026-08-13 every personalisation on that page was set BLIND:
// accent colour through a bare `<input type="color">`, the avatar as a raw URL
// text field, the tagline as a textarea — with no indication of what any of it
// would look like. The equipped border and banner were not even fetched there,
// because they are equipped from /rewards, a different page entirely. So the
// one screen called "edit your profile" could not show you your profile.
//
// ⚠ IT SHARES `lib/cosmetics.ts` WITH THE PUBLIC PAGE, DELIBERATELY. A preview
// that renders cosmetics from its own copy of the style map is worse than no
// preview: it would drift the moment a SKU is added and confidently show a
// collector something their visitors do not see. Same reason the accent ring
// and initials fallback mirror ProfileClient's Avatar rather than reinventing.
//
// Pure and prop-driven so it is unit-testable — the editor page itself is a
// `page.tsx`, measured by neither coverage gate.

import { borderCosmetic, bannerCosmetic } from "@/lib/cosmetics";
import { resolveAvatarUrl } from "@/lib/profile/default-avatar";

const DISPLAY = "var(--font-display)";
const MONO = "var(--font-mono)";
/** brand-exception: parsed by hexToRgba — must be a literal hex, not a CSS var. */
const FALLBACK_ACCENT = "#E03A2F";

export function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || "").replace("#", "");
  if (clean.length !== 6) return `rgba(224,58,47,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return `rgba(224,58,47,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Two-letter monogram, matching the public page's fallback avatar. */
export function initialsFor(displayName: string, username: string): string {
  const src = (displayName || username || "").trim();
  return src ? src.slice(0, 2).toUpperCase() : "?";
}

export default function ProfileHeaderPreview({
  username,
  displayName,
  tagline,
  avatarUrl,
  accentColor,
  equippedBorder,
  equippedBanner,
}: {
  username: string;
  displayName: string;
  tagline: string;
  avatarUrl: string;
  accentColor: string;
  equippedBorder?: string | null;
  equippedBanner?: string | null;
}) {
  const accent = accentColor || FALLBACK_ACCENT;
  const border = borderCosmetic(equippedBorder);
  const banner = bannerCosmetic(equippedBanner);
  const ringColor = border?.ring ?? hexToRgba(accent, 0.4);
  const ringWidth = border ? 3 : 2;
  // An avatar URL is typed a character at a time. Rendering `htt` as an <img>
  // guarantees a broken-image icon on nearly every keystroke, so the monogram
  // holds until the value is plausibly a URL.
  //
  // ⚠ EMPTY IS NOT MID-TYPING — it is the saved state "I have no avatar", which
  // now renders the RPC logo to visitors. Previewing a monogram for it would
  // make this component do the exact thing it exists to prevent: show the
  // collector something their visitors do not see.
  const typed = avatarUrl.trim();
  const showImage = typed === "" || /^https?:\/\/\S+$/i.test(typed);
  const previewSrc = resolveAvatarUrl(avatarUrl);

  return (
    <div
      data-testid="profile-header-preview"
      style={{
        border: "1px solid var(--rpc-border)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--rpc-black)",
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
          padding: "8px 10px 0",
        }}
      >
        Live preview
      </div>

      <div style={{ textAlign: "center", padding: "10px 16px 18px" }}>
        {banner && (
          <div
            aria-hidden
            data-testid="preview-banner"
            title={`${banner.label} banner`}
            style={{
              height: 56,
              borderRadius: 10,
              background: banner.background,
              marginBottom: -26,
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          />
        )}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 10, position: "relative" }}>
          {showImage ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={previewSrc}
              alt=""
              data-testid="preview-avatar-image"
              data-preview-avatar="ring"
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                objectFit: "cover",
                border: `${ringWidth}px solid ${ringColor}`,
                boxShadow: border?.glow ? `0 0 16px ${border.glow}` : undefined,
              }}
            />
          ) : (
            <div
              data-testid="preview-avatar-initials"
              data-preview-avatar="ring"
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: hexToRgba(accent, 0.15),
                border: `${ringWidth}px solid ${ringColor}`,
                boxShadow: border?.glow ? `0 0 16px ${border.glow}` : undefined,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: DISPLAY,
                fontWeight: 800,
                fontSize: 20,
                color: accent,
              }}
            >
              {initialsFor(displayName, username)}
            </div>
          )}
        </div>

        <div
          style={{
            fontFamily: DISPLAY,
            fontWeight: 900,
            fontSize: 22,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            lineHeight: 1,
            color: "var(--rpc-text-primary)",
          }}
        >
          {displayName.trim() || username.trim() || "Your name"}
        </div>

        {tagline.trim() && (
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: "var(--rpc-text-secondary)",
              letterSpacing: "0.06em",
              marginTop: 5,
            }}
          >
            {tagline.trim()}
          </div>
        )}

        <div
          style={{
            fontFamily: MONO,
            fontSize: 8,
            letterSpacing: "0.15em",
            color: "var(--rpc-text-ghost)",
            marginTop: 8,
          }}
        >
          {username.trim() ? `rippackscity.com/profile/${username.trim()}` : "SET A USERNAME"}
        </div>
      </div>
    </div>
  );
}
