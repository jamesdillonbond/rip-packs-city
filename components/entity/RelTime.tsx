"use client"

import { useEffect, useState } from "react"
import { EM_DASH, relTime } from "./_shared"

/**
 * Client-safe wrapper around `relTime` for use inside CLIENT components.
 *
 * `relTime` defaults its `now` to `Date.now()`, so a relative stamp rendered
 * during SSR is computed against the server's clock at render time and again
 * against the browser's clock at hydration. Those two moments are never the same
 * — and with any caching in front of the page they can be hours apart — so the
 * server text ("3 hours ago") and the first client text ("5 hours ago") differ:
 * React #418 on every load. That is exactly the class
 * `components/insights/FreshnessStamp.tsx` was created for, and this is the same
 * pattern applied to the entity Activity tables (edition / player / set pages).
 *
 * Server components may keep calling `relTime` directly — their output is never
 * re-rendered on the client, so there is nothing to mismatch.
 */
export default function RelTime({ iso }: { iso: string | null | undefined }) {
  // Stable on the server AND on the first client render; filled after mount.
  const [text, setText] = useState<string>(EM_DASH)

  useEffect(() => {
    setText(relTime(iso))
  }, [iso])

  return <>{text}</>
}
