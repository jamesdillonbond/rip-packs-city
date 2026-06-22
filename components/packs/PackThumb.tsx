"use client"

// components/packs/PackThumb.tsx
// Square pack thumbnail with a graceful onError fallback. Some pack art URLs
// are dead (e.g. AllDay's storage.cloud.google.com/dl-nfl-assets-prod/tmp/*
// pack images 404) — without an onError handler the tile renders a broken
// image icon. On load failure (or a null src) it falls back to a muted "Pack"
// placeholder, matching the server-rendered placeholder it replaces.

import { useState } from "react"

export default function PackThumb({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = useState(false)
  const show = !!src && !errored
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
          src={src as string}
          alt={alt}
          onError={() => setErrored(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span style={{ color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: 10 }}>Pack</span>
      )}
    </div>
  )
}
