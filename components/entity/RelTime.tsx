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
 * TWO-PHASE, LIKE FreshnessStamp (changed 2026-09-25): the SSR + first-client
 * value used to be a literal "—", so the SERVED HTML of every edition / player /
 * set Activity table carried no sale date at all — every "When" cell read "—"
 * to crawlers, unfurlers and no-JS readers (verified live on
 * /nba-top-shot/edition/100:3345, 30 of 30 rows). Now the initial value is the
 * DETERMINISTIC absolute date ("Sep 24, 2026", from getUTC* parts, so it cannot
 * vary by locale, ICU build or timezone), and the effect swaps in the relative
 * form after mount. "—" still means only: no timestamp was supplied.
 *
 * Server components may keep calling `relTime` directly — their output is never
 * re-rendered on the client, so there is nothing to mismatch.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Deterministic "Sep 24, 2026" from UTC parts; EM_DASH for empty/unparseable. */
export function absoluteDateUtc(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return EM_DASH
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

export default function RelTime({ iso }: { iso: string | null | undefined }) {
  // Stable on the server AND on the first client render; relative after mount.
  const [text, setText] = useState<string>(() => absoluteDateUtc(iso))

  useEffect(() => {
    setText(relTime(iso))
  }, [iso])

  return <span title={iso ?? undefined}>{text}</span>
}
