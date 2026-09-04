"use client"

// components/entity/IpfsThumb.tsx
//
// Square thumbnail for art served through /api/public/ipfs-media/<cid>, with the ONE-SHOT RETRY
// that route's own header assumes its consumers have.
//
// ⚠ THE 502 FROM THAT ROUTE IS A COLD-CACHE MISS, NOT A DEAD IMAGE. Measured 2026-09-04 against
// production, the three parallel-art CIDs on /nba-top-shot/edition/98:3150::5, three requests each:
//     QmbA28D3qsmYxVg49tXu…   502 (8.17s)   200 (0.36s)   200 (0.36s)
//     QmdAszc6oKXQjF5hVkBW…   200 (0.51s)   200 (0.56s)   200 (0.60s)
//     QmVa651F84NoFXAV9rE6…   200 (0.50s)   200 (0.60s)   200 (0.48s)
// The first hit on a cold CID exceeds the route's deliberate 8s HEADERS_TIMEOUT_MS and aborts to a
// 502; every request after it succeeds in well under a second. So the art is fine — **the first
// visitor to each CID is the only one who sees a broken image, and they see it permanently**,
// because a <img> does not retry a 502 on its own.
//
// The route already anticipated this: its header records that the 8s budget exists so "the 502
// fallback — and the <img onError> candidate-advance chain it exists to trigger" can actually run.
// The parallel-art tiles on the edition page had **no onError at all** (verified in a real browser:
// three 169×169 tiles, alt Coded/Halftone/Bubbled, hasOnError false), so the fallback had nothing
// to trigger. This supplies it.
//
// ⛔ The retry deliberately does NOT add a cache-busting query param: the second request must be
// able to hit our edge cache under the same key, and busting it would re-run the cold fetch that
// just timed out. Remounting the <img> via `key` is what forces the re-request.
//
// After the retry, it degrades to a muted label rather than a broken-image icon — the same shape
// components/packs/PackThumb.tsx uses for permanently dead pack art.

import { useEffect, useState } from "react"

const RETRY_DELAY_MS = 1_200

export default function IpfsThumb({
  src,
  alt,
  label,
  marginBottom = 8,
}: {
  src: string | null | undefined
  alt: string
  /** Shown when the image is unavailable after the retry. Falls back to `alt`. */
  label?: string | null
  marginBottom?: number
}) {
  // 0 = first attempt, 1 = the retry, 2 = given up.
  const [attempt, setAttempt] = useState(0)
  const [pendingRetry, setPendingRetry] = useState(false)

  useEffect(() => {
    if (!pendingRetry) return
    const t = setTimeout(() => {
      setPendingRetry(false)
      setAttempt((a) => a + 1)
    }, RETRY_DELAY_MS)
    return () => clearTimeout(t)
  }, [pendingRetry])

  const gaveUp = attempt >= 2
  const show = Boolean(src) && !gaveUp

  return (
    <div
      style={{
        aspectRatio: "1 / 1",
        background: "rgba(0,0,0,0.3)",
        borderRadius: 4,
        overflow: "hidden",
        marginBottom,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={attempt}
          src={src as string}
          alt={alt}
          loading="lazy"
          onError={() => {
            // One retry, then stop. A CID that fails twice is genuinely unavailable and saying so
            // is better than a third request the reader is still waiting on.
            if (attempt === 0) setPendingRetry(true)
            else setAttempt(2)
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span
          style={{
            color: "var(--rpc-text-ghost)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.06em",
            textAlign: "center",
            padding: 6,
          }}
        >
          {label ?? alt}
        </span>
      )}
    </div>
  )
}
