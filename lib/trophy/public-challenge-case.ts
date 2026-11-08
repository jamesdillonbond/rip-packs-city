// lib/trophy/public-challenge-case.ts
//
// One collector's ENTRY in one trophy challenge, read server-side for the share
// page /profile/<u>/trophy-case/<slug> and its social card (2026-11-07). Same
// anon-public RPC the profile's "other cases" block reads through
// /api/public/trophy-cases, so the share page cannot show a case the profile
// would not.
//
// ⚠ THREE STATES (CLAUDE.md "Honesty"): the read FAILED (`ok:false` — the page
// says so, the card falls back; never "not entered") · answered and this
// collector has NO entry for that challenge (`entry:null` — a 404) · the entry.
// ⚠ NEVER SUBSTITUTE: a missing entry is never answered with the collector's
// MAIN case or another challenge's — that would publish the wrong subject
// under this challenge's name.

import { cache } from "react"
import { supabase as supabaseAnon } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { isChallengeSlug } from "@/lib/trophy/challenge-link"

export interface PublicChallengeEntry {
  caseId: string
  challenge: { slug: string; title: string; tagline: string | null }
  /** Slabs in SLOT order (the order the owner arranged). */
  slabs: Array<Record<string, unknown>>
}

export type PublicChallengeCaseResult = { ok: true; entry: PublicChallengeEntry | null } | { ok: false }

/** Pure: pick `slug`'s entry out of the RPC's case list. */
export function pickChallengeEntry(cases: unknown, slug: string): PublicChallengeEntry | null {
  if (!Array.isArray(cases)) return null
  for (const c of cases as Array<Record<string, any>>) {
    const ch = c?.challenge
    if (!ch || typeof ch.slug !== "string" || ch.slug !== slug) continue
    const slabs = (Array.isArray(c.slabs) ? c.slabs : [])
      .filter((s: any) => s && typeof s.slot === "number")
      .sort((a: any, b: any) => a.slot - b.slot)
    return {
      caseId: String(c.id ?? ""),
      challenge: {
        slug: ch.slug,
        title: typeof ch.title === "string" && ch.title.trim() ? ch.title.trim() : slug,
        tagline: typeof ch.tagline === "string" ? ch.tagline : null,
      },
      slabs,
    }
  }
  return null
}

/** Request-memoized, so the page and its generateMetadata share one read. */
export const getPublicChallengeCase = cache(
  async (username: string, slug: string): Promise<PublicChallengeCaseResult> => {
    const u = username.trim()
    if (!u || !isChallengeSlug(slug)) return { ok: true, entry: null }
    try {
      const { data, error } = await boundedRead(
        (supabaseAnon as any).rpc("get_trophy_cases_by_username", { p_username: u }),
        "lib/trophy/public-challenge-case/get_trophy_cases_by_username"
      )
      if (error) {
        console.error("[public-challenge-case]", error)
        return { ok: false }
      }
      return { ok: true, entry: pickChallengeEntry(data, slug) }
    } catch (e) {
      console.error("[public-challenge-case] threw", e)
      return { ok: false }
    }
  }
)
