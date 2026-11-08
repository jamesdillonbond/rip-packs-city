// lib/trophy/challenge-probe.ts
//
// Server-side existence read for /trophy-challenges/<slug> (2026-11-06).
//
// Before this, the page shell answered HTTP 200 for ANY slug and only the
// client learned (from the API's 404) that the challenge did not exist — a soft
// 404. The page now asks once, server-side, and calls notFound() on a slug the
// database says is unknown.
//
// ⚠ THREE outcomes, never two (CLAUDE.md "Honesty"):
//   found    — the challenge exists; its title feeds <title>.
//   missing  — the read SUCCEEDED and returned NULL (the RPC's documented
//              answer for an unknown slug). Only this one may become a 404.
//   unknown  — the read FAILED or overran its budget. The page still renders and
//              ChallengeBoardClient shows its own retry notice. A failed read must
//              never be published as "this challenge does not exist".

import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { supabase } from "@/lib/supabase"

export type ChallengeProbe =
  | { kind: "found"; title: string; tagline: string | null; entryCount?: number | null }
  | { kind: "missing" }
  | { kind: "unknown" }

export const CHALLENGE_PROBE_TIMEOUT_MS = 3000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function probeTrophyChallenge(db: any, slug: string): Promise<ChallengeProbe> {
  try {
    const { data, error } = await withBoardBudget(
      // p_limit 1 is the RPC's floor (it clamps to GREATEST(1, …)): the cheapest
      // read that still answers "does this slug exist".
      db.rpc("get_trophy_challenge_entries", { p_slug: slug, p_limit: 1 }) as Promise<{ data: unknown; error: unknown }>,
      "probe",
      CHALLENGE_PROBE_TIMEOUT_MS,
      "trophy-challenges/",
    )
    if (error) {
      console.error("[trophy-challenges/probe]", error)
      return { kind: "unknown" }
    }
    if (data == null) return { kind: "missing" }
    const ch = (data as { challenge?: { title?: unknown; tagline?: unknown } }).challenge
    const count = (data as { entry_count?: unknown }).entry_count
    if (!ch || typeof ch.title !== "string" || ch.title.trim() === "") {
      // A body we cannot read is not evidence of absence.
      return { kind: "unknown" }
    }
    return {
      kind: "found",
      title: ch.title,
      tagline: typeof ch.tagline === "string" ? ch.tagline : null,
      // For the link preview's line; null (not 0) when the payload lacked it.
      entryCount: typeof count === "number" ? count : null,
    }
  } catch (e) {
    console.error("[trophy-challenges/probe]", e instanceof Error ? e.message : e)
    return { kind: "unknown" }
  }
}

/** The page's entry point: the anon client (the RPC is granted to anon). */
export function probeTrophyChallengeLive(slug: string): Promise<ChallengeProbe> {
  return probeTrophyChallenge(supabase, slug)
}
