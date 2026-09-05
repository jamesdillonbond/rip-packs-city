"use client"

// components/media/IpfsImg.tsx
//
// The ONE-SHOT RETRY from `lib/media/use-ipfs-retry.ts`, in a wrapper that keeps
// the caller's markup instead of imposing its own.
//
// ⚠ WHY THIS EXISTS ALONGSIDE `components/entity/IpfsThumb.tsx`, which already
// does the retry: `IpfsThumb` also owns its layout — a square wrapper div, a
// fixed `aspectRatio`, a `marginBottom`, and a muted text fallback. That is right
// for the entity page it was written for and wrong as a general drop-in: the two
// call sites on the collection MARKET page are an `objectFit: cover` fill inside
// an existing aspect-ratio box, and an 80×80 table cell. Swapping either for
// `IpfsThumb` would have changed the page's layout to fix a broken image.
//
// ⚠ MEASURED, which is why this was worth doing at all. Live on
// `/nba-top-shot/market`, 2026-09-04: **12 of 15 `/api/public/ipfs-media/` images
// returned 502 and rendered blank** — an 80% failure rate on a public page. The
// same CID, requested three times: 502 (8.16s), 502 (8.13s), **200 (0.49s,
// 2.58 MB)**. Upstream `ipfs.io` answered **504 after 28.6s** for it. So the art
// is fine; the FIRST visitor to a cold CID pays the route's deliberate 8s
// headers budget, gets a 502, and an `<img>` never retries a 502 on its own.
//
// ⭐ The retry already existed and was applied to two surfaces (the edition page
// and `/insights/trophies`) and not to the market page, which is the one that
// renders fifteen of these at once. Same shape as the route's own header, which
// records that its 8s budget was chosen so a "`<img onError>` candidate-advance
// chain" could run — on this page there was no `onError` at all.
//
// ⛔ Do NOT add a cache-busting param to force the retry. `use-ipfs-retry`'s
// header explains why: the second request must hit our edge cache under the SAME
// key, and busting it re-runs the cold upstream fetch that just timed out —
// turning a one-visitor defect into an every-visitor one. The `key` remount is
// what re-requests.

import type { CSSProperties } from "react"
import { useIpfsRetry } from "@/lib/media/use-ipfs-retry"

export default function IpfsImg({
  src,
  alt,
  style,
  width,
  height,
  className,
}: {
  src: string | undefined
  alt: string
  style?: CSSProperties
  width?: number
  height?: number
  className?: string
}) {
  const { key, onError, failed } = useIpfsRetry()

  // After the retry, render NOTHING rather than a broken-image glyph — the
  // caller's container supplies its own background/placeholder, which is what it
  // already shows for a listing with no thumbnail at all. A CID that fails twice
  // is genuinely unavailable and saying nothing beats a broken icon.
  if (!src || failed) return null

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={key}
      src={src}
      alt={alt}
      loading="lazy"
      onError={onError}
      width={width}
      height={height}
      className={className}
      style={style}
    />
  )
}
