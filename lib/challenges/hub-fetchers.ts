// lib/challenges/hub-fetchers.ts
//
// The single read behind /[collection]/challenges.
//
// Extracted from `page.tsx` for the same two reasons as
// `lib/hot-floors/fetchers.ts`: the read was UNBOUNDED (a hang throws nothing,
// so the page's `try/catch` could not reach its own error branch and the
// document never completed), and `app/**/page.tsx` is measured by NEITHER
// coverage gate, so nothing pinned the honest-vs-empty distinction.
//
// ⚠ Named `hub-fetchers` rather than `fetchers` because `lib/challenges/`
// already holds `topshot-ingest.ts`; a bare `fetchers.ts` there would read as
// the ingest's data layer rather than the hub page's.
//
// ⚠ THE PAGE'S HONESTY BRANCH ALREADY EXISTED: "Couldn't load challenges right
// now" on `errored`, separately from the empty state. Only a read that SUCCEEDED
// may claim there are no active challenges.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * ⚠ Heavier than it looks: `get_active_challenges` prices each challenge's
 * completion cost at the current floor and its reward as pack EV or moment FMV,
 * so it is an aggregate over the catalogue rather than a lookup. The page is
 * `revalidate`-cached, so a cold entry performs it inline.
 */
export const CHALLENGES_TIMEOUT_MS = 8_000

/**
 * ⚠ camelCase, not snake_case — the RPC returns a JSON payload the page consumes
 * verbatim, so these field names are the RPC's, not a table's. Copied from the
 * page rather than retyped: a "tidied" shape here would compile and render blanks.
 */
export interface ChallengeRow {
  challengeId: string
  slug: string
  name: string
  challengeType: string
  endsAt: string | null
  rewardKind: string | null
  rewardLabel: string | null
  totalRewardAllocation: number | null
  completedCount: number | null
  totalRequired: number
  missingCount: number
  unresolvedSlots?: number
  completionPct: number | null
  costToComplete: number | null
  rewardValue: number | null
  netEv: number | null
  worthIt: boolean | null
}

/**
 * ⚠ `ok` answers *did the READ succeed*, never *are there challenges*. Top Shot
 * genuinely runs none between events, and the page must keep being able to say
 * so.
 */
export interface ChallengesResult {
  challenges: ChallengeRow[]
  ok: boolean
}

export async function fetchActiveChallenges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = CHALLENGES_TIMEOUT_MS,
): Promise<ChallengesResult> {
  try {
    const { data, error } = await withBoardBudget<{
      data: { challenges?: unknown } | null
      error: { message: string } | null
    }>(
      db.rpc("get_active_challenges", { p_wallet: null }),
      "challenges",
      timeoutMs,
      "collection/",
    )
    if (error) {
      console.error("[challenges] read error:", error.message)
      return { challenges: [], ok: false }
    }
    // ⚠ A non-array payload is a shape change, not an empty result — see the
    // same note in lib/hot-floors/fetchers.ts.
    const rows = data?.challenges
    if (rows != null && !Array.isArray(rows)) {
      console.error("[challenges] unexpected payload shape")
      return { challenges: [], ok: false }
    }
    return { challenges: (rows ?? []) as ChallengeRow[], ok: true }
  } catch (e) {
    console.error("[challenges] read bound:", e instanceof Error ? e.message : e)
    return { challenges: [], ok: false }
  }
}
