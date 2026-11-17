/**
 * lib/og/marks.tsx — the OG cards' own glyph vocabulary.
 *
 * WHY THIS EXISTS: AN EMOJI IN AN OG CARD IS A THIRD-PARTY NETWORK CALL, ON THE
 * ONE PATH A SOCIAL CRAWLER IS WAITING ON.
 *
 * `next/og` resolves glyphs at RENDER time, and it has TWO remote fallbacks,
 * both unbounded and neither declared anywhere before this file:
 *
 *   1. EMOJI -> `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/<cp>.svg`
 *   2. ANY GLYPH THE SUPPLIED FONTS DO NOT COVER -> `https://fonts.googleapis.com/
 *      css2?family=Noto+Sans+Symbols…`
 *
 * Both measured 2026-08-29 by rendering one character per `ImageResponse` with
 * the network closed and recording the escapes:
 *
 *   🎯 1f3af · ⭐ 2b50 · 📦 1f4e6 · 🎉 1f389 · 🎴 1f3b4 · 💎 1f48e · 🏆 1f3c6
 *   ⚡ 26a1 · 📚 1f4da · 💰 1f4b0 · 🎒 1f392   -> jsdelivr, every one
 *   ★ 2605 · ◈ 25c8 · ▣ 25a3 · ▦ 25a6          -> fonts.googleapis.com
 *   → 2192 · ↑ 2191 · ↓ 2193 · ← 2190           -> fonts.googleapis.com
 *   ▲ 25b2 · ▼ 25bc · ✓ 2713 · ✕ 2715 · № 2116  -> fonts.googleapis.com
 *
 * ⚠ THE SECOND FALLBACK IS THE ONE NOBODY HAD RECORDED, AND IT IS ONLY VISIBLE
 * IF THE PROBE SUPPLIES THE BRAND FONTS. Satori's bundled default covers arrows;
 * production never uses it, because every card passes `brandFonts()`. A first
 * pass here rendered one character per `ImageResponse` with no `fonts` option,
 * saw `→` fetch nothing, and concluded the register had wrongly recorded
 * `insights/serial-premiums`. Re-run the same probe the way production renders
 * and `→` fetches Google Fonts. The register was right; the probe differed from
 * production in the one dimension the answer depended on.
 *
 * What the brand fonts DO cover, tested identically, so it is safe as text:
 * every accented Latin name that matters here (Jokić, Dončić, Porziņģis,
 * Şengün, Bogdanović) and `· – — • … × −`. That last one is load-bearing: a
 * source scan flags the U+2212 MINUS SIGN in og/pack and og/pack/lifecycle and
 * the render clears it — which is why the RENDER, not the scan, is the guard.
 *
 * And neither instrument is a census: `og/collection` reached the CDN through
 * DATA (`collection.icon`, every registry value an emoji), which no source scan
 * could ever have seen.
 *
 * ⛔ THERE IS NO CONFIG FIX. `ImageResponseOptions` exposes one knob,
 * `emoji?: EmojiType`, and all four presets (twemoji/openmoji/blobmoji/noto) are
 * remote URLs. There is no `loadAdditionalAsset` hook on the public API. The
 * only way off the network is to stop asking for a glyph nobody local can draw.
 *
 * ⭐ SO WE DRAW THEM. Satori renders inline `<svg>` with no network and no font
 * dependency (verified the same way: 0 fetches, real PNG bytes). These marks are
 * original geometry — not vendored Twemoji, which is CC-BY art we would have to
 * attribute and could not have fetched from this sandbox anyway.
 *
 * THE DESIGN CALL, STATED SO IT CAN BE ARGUED WITH: RPC's card system is
 * brutalist and typographic — Barlow Condensed Black, Share Tech Mono, a dark
 * ground, one accent. Twemoji's rounded multicolour cartoons were the one
 * element on those cards that came from somebody else's design language, and at
 * the sizes they actually rendered (20px in the profile badge row, 26px in the
 * pack/deal eyebrow) their detail was not legible anyway. A monoline mark in the
 * card's OWN accent is more legible at those sizes, not less.
 *
 * ⚠ EVERY MARK MUST STAY PURE GEOMETRY. No text, no `currentColor`, no CSS
 * variable — satori resolves none of them, and the moment a mark needs a glyph
 * it is a font fetch again. Colour arrives as an explicit prop.
 */

import type { ReactElement } from "react"

export type MarkName =
  | "target"
  | "star"
  | "pack"
  | "burst"
  | "bag"
  | "diamond"
  | "trophy"
  | "bolt"
  | "stack"
  | "coin"
  | "arrow"

export interface MarkProps {
  /** Rendered box in px, both axes. The geometry is a 24x24 viewBox. */
  size?: number
  /** An explicit colour (hex or rgba). Never a CSS var — satori resolves none. */
  color?: string
  /**
   * Stroke weight in VIEWBOX units, so a mark keeps its optical weight as it
   * scales. 2 at size 24 is the reference; the pack/deal eyebrows render at 26
   * and the profile badges at 20, both inside that mark's legible range.
   */
  weight?: number
}

/**
 * Shared stroke attributes. `strokeLinejoin: round` matters at 20px: a mitred
 * join on the diamond and bolt reads as a spike at that scale.
 */
function strokeAttrs(color: string, weight: number) {
  return {
    stroke: color,
    strokeWidth: weight,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  }
}

/**
 * The one entry point. `name` is a closed union, so a card cannot ask for a mark
 * that does not exist and silently fall back to a glyph — the failure would be a
 * network call, which is the exact thing this module exists to prevent.
 */
export function OgMark({
  name,
  size = 24,
  color = "#E03A2F",
  weight = 2,
}: MarkProps & { name: MarkName }): ReactElement {
  const s = strokeAttrs(color, weight)
  const box = { width: size, height: size, viewBox: "0 0 24 24" }

  switch (name) {
    // A sniper reticle. Replaces 🎯 in the /api/og/deal eyebrow and the
    // `serial_sniper` achievement.
    case "target":
      return (
        <svg {...box}>
          <circle cx="12" cy="12" r="8.5" {...s} />
          <circle cx="12" cy="12" r="3.5" {...s} />
          <circle cx="12" cy="12" r="1" fill={color} />
          <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" {...s} />
        </svg>
      )

    // Replaces ⭐ in the deal card's badge pill and ★ (a Google-Fonts fetch, not
    // a Twemoji one) as the unknown-achievement fallback.
    case "star":
      return (
        <svg {...box}>
          <path
            d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.4l-5.81 3-1.11-6.47L.38 9.35l6.5-.95z"
            {...s}
          />
        </svg>
      )

    // A sealed pack, isometric. Replaces 📦 in /api/og/pack and the unripped
    // branch of /api/og/pack/lifecycle.
    case "pack":
      return (
        <svg {...box}>
          <path d="M12 2.5l9 4.7-9 4.7-9-4.7z" {...s} />
          <path d="M3 7.2v9.4l9 4.9V11.9" {...s} />
          <path d="M21 7.2v9.4l-9 4.9" {...s} />
        </svg>
      )

    // A rip. Replaces 🎉 on the ripped branch of /api/og/pack/lifecycle — the
    // one place the emoji carried STATE rather than decoration, so the two
    // marks are deliberately as different in silhouette as the box and a burst.
    case "burst":
      return (
        <svg {...box}>
          <circle cx="12" cy="12" r="3.2" {...s} />
          <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" {...s} />
          <path d="M4.6 4.6l2.9 2.9M16.5 16.5l2.9 2.9M19.4 4.6l-2.9 2.9M7.5 16.5l-2.9 2.9" {...s} />
        </svg>
      )

    // `pack_hunter`. The pocket line the first draft carried read as a MINUS
    // SIGN at 20px, so the badge said "not a pack hunter"; a tapered bag with
    // handles and no interior detail survives the downscale.
    case "bag":
      return (
        <svg {...box}>
          <path d="M3.6 8.2h16.8l-1.4 12.2H5z" {...s} />
          <path d="M8.5 8.2V6a3.5 3.5 0 0 1 7 0v2.2" {...s} />
        </svg>
      )

    // `diamond_hands`.
    case "diamond":
      return (
        <svg {...box}>
          <path d="M12 2.5l8.5 7-8.5 12-8.5-12z" {...s} />
          <path d="M3.5 9.5h17" {...s} />
          <path d="M8.2 9.5L12 21.5M15.8 9.5L12 21.5" {...s} />
        </svg>
      )

    // `trophy_curator`.
    case "trophy":
      return (
        <svg {...box}>
          <path d="M7.5 3.5h9v5.5a4.5 4.5 0 0 1-9 0z" {...s} />
          <path d="M7.5 5H4.8v1.4a3.4 3.4 0 0 0 3 3.3" {...s} />
          <path d="M16.5 5h2.7v1.4a3.4 3.4 0 0 1-3 3.3" {...s} />
          <path d="M12 13.5v4M8 20.5h8" {...s} />
        </svg>
      )

    // `challenge_accepted`. Also the shape ⚡ carries in the mobile tab bar, so
    // the two surfaces stay recognisably the same idea.
    case "bolt":
      return (
        <svg {...box}>
          <path d="M13.5 2.5L4.5 13.8h6l-1 7.7 9-11.3h-6z" {...s} />
        </svg>
      )

    // `series_collector` — a series as a stack, widest at the base.
    case "stack":
      return (
        <svg {...box}>
          <path d="M3.5 15.5h17v5h-17z" {...s} />
          <path d="M5.5 10h13v5.5h-13z" {...s} />
          <path d="M7.5 4.5h9V10h-9z" {...s} />
        </svg>
      )

    // A right arrow. NOT decorative — on /api/og/insights/serial-premiums it is
    // the relation between two numbers ("median -> last sale"), so it cannot be
    // dropped the way an ornament can.
    //
    // ⚠ THIS ONE IS WHY THE MEASUREMENT ABOVE HAD TO BE REDONE WITH THE BRAND
    // FONTS SUPPLIED. The first probe rendered one character per ImageResponse
    // with NO `fonts` option and recorded no fetch for "→", which read as
    // "the register was wrong to record this route". It was not: satori's
    // BUNDLED default font covers arrows, and production never uses it — every
    // card passes `brandFonts()`. Re-run with Barlow Condensed + Share Tech Mono
    // supplied, "→" fetches Google Fonts, and so do
    // "↑ ↓ ← ▲ ▼ ✓ ✕ № ‾".
    // A probe whose harness differs from production in the one dimension the
    // result depends on is not a measurement of production.
    //
    // (What IS covered, tested the same way and therefore safe as text: every
    // accented Latin name that matters here — Jokić, Dončić,
    // Porziņģis, Şengün, Bogdanović — plus
    // "· – — • … × −". The last one is
    // load-bearing: og/pack and og/pack/lifecycle both render U+2212 MINUS SIGN,
    // which the scan flags and the render clears.)
    case "arrow":
      return (
        <svg {...box}>
          <path d="M3.5 12h16" {...s} />
          <path d="M13.5 6l6 6-6 6" {...s} />
        </svg>
      )

    // `big_spender`, as a stack of coins rather than a single one. The first
    // draft was concentric circles, which at the 20px the profile badge row
    // actually renders is the SAME silhouette as `target` — and both marks can
    // appear in that row at once (`serial_sniper` + `big_spender`), so the two
    // were indistinguishable exactly where it mattered. Deliberately NOT a "$":
    // a text glyph here is a font lookup, and the whole point of this module is
    // that a card renders no glyph it cannot draw.
    case "coin":
      return (
        <svg {...box}>
          <ellipse cx="12" cy="6.2" rx="7.5" ry="3.2" {...s} />
          <path d="M4.5 6.2v5c0 1.77 3.36 3.2 7.5 3.2s7.5-1.43 7.5-3.2v-5" {...s} />
          <path d="M4.5 11.6v5c0 1.77 3.36 3.2 7.5 3.2s7.5-1.43 7.5-3.2v-5" {...s} />
        </svg>
      )
  }
}
