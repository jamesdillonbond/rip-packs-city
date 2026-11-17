"use client"

// lib/media/use-ipfs-retry.ts
//
// One retry for media served through /api/public/ipfs-media/<cid>.
//
// ⚠ THAT ROUTE'S 502 IS A COLD-CACHE MISS, NOT A DEAD IMAGE. Measured in production 2026-09-04,
// three requests each against the parallel art on /nba-top-shot/edition/98:3150::5:
//     QmbA28D3qsmYxVg49tXu…   502 (8.17s)   200 (0.36s)   200 (0.36s)
// A cold CID exceeds the route's deliberate 8s HEADERS_TIMEOUT_MS and aborts to a 502; every
// request after it is a sub-second 200. So **the first visitor to each CID is the only one who
// sees the failure, and they see it permanently** — an <img> does not retry a 502 on its own.
// The route's own header records that the 8s budget was chosen so its 502 could trigger an
// "<img onError> candidate-advance chain"; this is that chain, in the smallest honest form.
//
// A surface that already had an onError was still affected: it gave up on the FIRST error, so it
// showed its fallback where one retry would have shown the real art (measured on
// /insights/trophies, which has exactly that shape).
//
// ⛔ THE RETRY MUST NOT CACHE-BUST. The obvious way to force a re-request is `?t=<now>`, and it is
// wrong here: the second request has to be able to hit our edge cache under the SAME key, and a
// busted URL would re-run the cold upstream fetch that just timed out — turning a one-visitor
// defect into an every-visitor one. Remount the <img> via the returned `key` instead.
//
// Usage:
//   const { key, onError, failed } = useIpfsRetry()
//   failed ? <Fallback/> : <img key={key} src={src} onError={onError} />

import { useEffect, useState } from "react"

export const IPFS_RETRY_DELAY_MS = 1_200

export function useIpfsRetry(): { key: number; onError: () => void; failed: boolean } {
  // 0 = first attempt, 1 = the retry, 2 = given up.
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => {
      setPending(false)
      setAttempt((a) => a + 1)
    }, IPFS_RETRY_DELAY_MS)
    return () => clearTimeout(t)
  }, [pending])

  return {
    key: attempt,
    failed: attempt >= 2,
    onError: () => {
      // One retry, then stop. A CID that fails twice is genuinely unavailable, and saying so beats
      // a third request the reader is still waiting on.
      if (attempt === 0) setPending(true)
      else setAttempt(2)
    },
  }
}
