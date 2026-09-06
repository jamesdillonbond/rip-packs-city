"use client"

// components/packs/PackThumb.tsx
// Square pack thumbnail with a graceful onError fallback. Some pack art URLs
// are dead (e.g. AllDay's storage.cloud.google.com/dl-nfl-assets-prod/tmp/*
// pack images 404) — without an onError handler the tile renders a broken
// image icon. On load failure (or a null src) it falls back to a muted "Pack"
// placeholder, matching the server-rendered placeholder it replaces.
//
// ⚠ TWO ways a dead URL survived the onError handler, both measured 2026-09-06
// on a real 390px Chromium across 60 AllDay + 25 Golazos edition pages:
//
//  1. THE ERROR FIRED BEFORE HYDRATION. This component is server-rendered, so
//     the browser starts (and, for a CSP-blocked or 404 host, FINISHES) the
//     image load before React attaches `onError`. The event is gone by the time
//     the handler exists, `errored` never flips, and the broken-image glyph
//     stays on the page forever. The mount effect below reads the DOM's own
//     verdict — `complete && naturalWidth === 0` is the browser saying "I tried
//     and failed" — and catches up. (`naturalWidth === 0` alone means "not
//     requested yet" on a lazy image — see headless-qa-fails-toward-false-
//     positives — which is why `complete` is part of the test.)
//
//  2. THE SRC IS NOT AN IMAGE. Five AllDay distributions carry an `.mp4` in
//     `image_url` (HoloIcon3_Pack_Reward.mp4, a Launch Codes rip video); an
//     <img> cannot render it, and the error fires the same way. A non-image
//     src is treated as no src at all.

import { useEffect, useRef, useState } from "react"

const NON_IMAGE_SRC = /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i

export function isRenderablePackArtSrc(src: string | null | undefined): src is string {
  return !!src && !NON_IMAGE_SRC.test(src)
}

export default function PackThumb({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const show = isRenderablePackArtSrc(src) && !errored

  useEffect(() => {
    // Catch an error that fired before hydration (case 1 above) by REPLAYING
    // the event the handler missed, so the one onError path owns the state.
    const el = imgRef.current
    if (el && el.complete && el.naturalWidth === 0) el.dispatchEvent(new Event("error"))
  }, [src])

  return (
    <div
      style={{
        aspectRatio: "1 / 1",
        background: "rgba(0,0,0,0.3)",
        borderRadius: 4,
        overflow: "hidden",
        marginBottom: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={src as string}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setErrored(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span style={{ color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: 10 }}>Pack</span>
      )}
    </div>
  )
}
