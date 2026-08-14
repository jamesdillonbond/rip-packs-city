// lib/og/entity-card.tsx
//
// Shared 1200×630 Open Graph card renderer for the entity detail routes
// (/api/og/{edition,set,player,team,series}). One single-hero layout when a
// card has one image (edition / player), a 2×2 montage layout when it has
// several (set / team / series). next/og's satori renderer does NOT resolve
// CSS custom properties, so every color is a hex literal and every flex node
// declares display:"flex".

import { ImageResponse } from "next/og"
import { ogImageDataUris } from "@/lib/og/img-data"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS } from "@/lib/og/brand-fonts"

export const FALLBACK_RED = "#E03A2F"

export interface EntityOgOpts {
  eyebrow: string          // e.g. "NBA TOP SHOT · SET"
  title: string
  subtitle?: string | null
  accent?: string | null
  images: string[]         // 0 = no media; 1 = single hero; >1 = montage
  statLabel?: string | null
  statValue?: string | null
}

export async function renderEntityOg(opts: EntityOgOpts): Promise<ImageResponse> {
  const accent = opts.accent || FALLBACK_RED
  // Brand typography for all five entity cards at once — these are the images
  // behind every shared edition/set/player/team/series link. `brandFonts` never
  // rejects and validates the bytes before satori sees them, so an unreachable
  // or non-font response degrades to the generic face rather than a broken card.
  const fonts = await brandFonts().catch(() => undefined)
  const fam = brandFamilies(fonts)
  // Pre-fetch every image to a data URI (timeout + byte-cap, failures dropped)
  // so Satori does zero network I/O — a single dead/slow upstream (e.g. the
  // ipfs.dapperlabs.com art on pre-2022 Top Shot editions) used to 500 the
  // whole card and kill the social preview. See lib/og/img-data.ts.
  const imgs = await ogImageDataUris((opts.images || []).filter(Boolean).slice(0, 4))
  const single = imgs.length <= 1

  const MediaPane = (
    <div
      style={{
        width: 520,
        height: 630,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
        background: "#0a0a0a",
      }}
    >
      {imgs.length === 0 ? (
        <div style={{ display: "flex", color: "#555", fontSize: 22, letterSpacing: 6, textTransform: "uppercase" }}>
          Rip Packs City
        </div>
      ) : single ? (
        <div
          style={{
            width: 440,
            height: 440,
            border: `4px solid ${accent}`,
            borderRadius: 16,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#000",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imgs[0]} alt="" width={440} height={440} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      ) : (
        <div style={{ width: 460, height: 460, display: "flex", flexWrap: "wrap", gap: 12 }}>
          {imgs.slice(0, 4).map((src, i) => (
            <div
              key={i}
              style={{
                width: 224,
                height: 224,
                borderRadius: 12,
                overflow: "hidden",
                display: "flex",
                border: `2px solid ${accent}55`,
                background: "#000",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" width={224} height={224} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#000", color: "#fff", fontFamily: fam.display }}>
        {MediaPane}
        <div
          style={{
            flex: 1,
            padding: "56px 56px 56px 8px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ fontSize: 18, letterSpacing: 4, textTransform: "uppercase", color: "#9CA3AF", display: "flex", fontFamily: fam.mono }}>
              {opts.eyebrow}
            </div>
            <div style={{ fontSize: 58, fontWeight: 900, lineHeight: 1.04, letterSpacing: 1, display: "flex" }}>
              {opts.title}
            </div>
            {opts.subtitle ? (
              <div style={{ fontSize: 24, color: "#9CA3AF", display: "flex" }}>{opts.subtitle}</div>
            ) : null}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            {opts.statLabel && opts.statValue ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 14, letterSpacing: 4, textTransform: "uppercase", color: "#9CA3AF", display: "flex", fontFamily: fam.mono }}>
                  {opts.statLabel}
                </div>
                <div style={{ fontSize: 56, fontWeight: 900, color: accent, display: "flex" }}>{opts.statValue}</div>
              </div>
            ) : (
              <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: 3, color: FALLBACK_RED, display: "flex" }}>
                RIP PACKS CITY
              </div>
            )}
            <div style={{ fontSize: 14, color: "#6B7280", fontWeight: 600, display: "flex", fontFamily: fam.mono }}>rippackscity.com</div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      ...(fonts ? { fonts } : {}),
      headers: OG_CACHE_HEADERS,
    },
  )
}
