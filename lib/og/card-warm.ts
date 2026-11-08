// lib/og/card-warm.ts
//
// Re-render a collector's cards right after their pins change (2026-11-07).
// The card URLs carry a content token (lib/og/card-url pinsToken), so a pin
// change points every share at a NEW card that nobody has rendered — and a
// cold render (~8–11 s) loses to a link-preview crawler. tetrislblock pinned
// six Dame pieces in a minute and pasted the link; this asks for the new card
// once, in the background, so it is in the store before the link is pasted.
//
// Fire-and-forget: scheduled with next/server's `after`, never awaited by the
// write it follows, never throws, and a failure only means the first crawler
// gets the neutral card (lib/og/card-store's deadline path).

import { after } from "next/server"
import { ogFetch, OG_FETCH_TIMEOUT_MS } from "@/lib/og/og-fetch"
import { boundedRead } from "@/lib/api/bounded-read"
import { ogProfileCardPath, ogTrophyCaseCardPath, pinsToken } from "@/lib/og/card-url"
import { challengeCaseOgPath } from "@/lib/trophy/challenge-link"
import { challengeBoardToken } from "@/lib/trophy/challenge-copy"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

/** The card paths that changed when `caseId` (null = the main case) changed. */
export async function cardPathsAfterPinChange(db: any, userId: string, caseId: string | null): Promise<string[]> {
  // Every read bounded: this runs in after(), but an unbounded read still
  // holds the function open (og-cards-bound-their-database-reads).
  const read = (q: any, label: string) => boundedRead(q, `og/card-warm/${label}`, OG_FETCH_TIMEOUT_MS)
  const bio = await read(db.from("profile_bio").select("username").eq("user_id", userId).limit(1), "profile_bio")
  const username: string | undefined = (bio.data as any)?.[0]?.username ?? undefined
  if (bio.error || !username) return [] // no public handle → no public card

  if (caseId == null) {
    const pins = await read(db.from("trophy_moments").select("slot, moment_id").eq("user_id", userId).is("case_id", null), "main")
    if (pins.error) return []
    const t = pinsToken(pins.data as any)
    return [ogProfileCardPath(username, t), ogTrophyCaseCardPath(username, t)]
  }

  const c = await read(
    db.from("trophy_cases").select("id, trophy_challenges(slug)").eq("id", caseId).eq("user_id", userId).limit(1),
    "case",
  )
  const ch = (c.data as any)?.[0]?.trophy_challenges
  const slug: string | undefined = (Array.isArray(ch) ? ch[0] : ch)?.slug ?? undefined
  if (c.error || !slug) return [] // a named case has no card of its own
  const pins = await read(db.from("trophy_moments").select("slot, moment_id").eq("user_id", userId).eq("case_id", caseId), "entry")
  if (pins.error) return []
  const paths = [challengeCaseOgPath(username, slug, pinsToken(pins.data as any))]
  // The challenge BOARD card changed too (#239): warm it at its new token.
  const board = await read(db.rpc("get_trophy_challenge_entries", { p_slug: slug, p_limit: 6 }), "board")
  const bt = board.error ? null : challengeBoardToken(board.data)
  if (bt) paths.push(`/api/og/trophy-challenge/${encodeURIComponent(slug)}?s=${bt}`)
  return paths
}

export async function warmCardsAfterPinChange(db: any, userId: string, caseId: string | null): Promise<void> {
  try {
    const paths = await cardPathsAfterPinChange(db, userId, caseId)
    await Promise.all(
      paths.map((p) =>
        ogFetch(`${BASE_URL}${p}`)
          .then((r) => r.body?.cancel())
          .catch(() => {}),
      ),
    )
  } catch {
    // best-effort
  }
}

/** Schedule the warm after the response; a no-op outside a request (tests, scripts). */
export function warmCardsLater(db: any, userId: string, caseId: string | null): void {
  try {
    after(() => warmCardsAfterPinChange(db, userId, caseId))
  } catch {
    // `after` outside a request scope — nothing to warm for.
  }
}
