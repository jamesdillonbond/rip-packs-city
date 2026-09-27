// app/api/panini-set-progress/route.ts
//
// Panini Sets tab backend (2026-09-27). Panini's 62 WC Prizm sets, one row each,
// from `panini_set_progress(p_username)` (migrations 20260927163619 +
// 20260927163719). The generic /api/sets-db cannot serve Panini: it keys on a
// wallet ADDRESS and on `editions` set membership, while a Panini owner is a
// USERNAME and Panini's set catalogue lives in `panini_editions`.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · Panini publishes NO checklist. Every count is editions RPC has SEEN (a card
//     of it has been listed), so "499 editions" is a floor on the set, not its
//     size. The tab carries the listing-gated coverage note for that reason.
//   · Cost to finish is the sum of today's lowest CONFIRMED asks (re-read in the
//     last 7 days) over the missing editions that have one. Editions with no such
//     ask are counted (`missingUnasked`) and never priced as $0 — the cost is a
//     floor too. The largest single ask is returned beside the total because the
//     total is concentrated (one Messi /10 ask was $100k of a $185k set).
//   · A username is matched case-insensitively (panini_card_serials.owner is 71%
//     mixed case; folding is collision-free). "Owned" means RPC has SEEN a serial
//     of that edition under the username on its last read — point-in-time, and
//     blind to cards never listed. The payload says when it last saw one.
//   · A malformed username is a 400 for the username, never an all-zero tracker.
//     A username RPC has never seen is `userSeen: false`, not "0 of 499 owned".
//   · A failed read is a 503 through `apiErrorResponse`, never an empty list.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { readPaniniCoverage } from "@/lib/panini/coverage"
import { normalizePaniniUsername } from "@/lib/profile/collector-identities"
import { parsePaniniSetRow } from "@/lib/panini/set-progress"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("username") ?? "").trim()
  let username: string | null = null
  if (raw) {
    username = normalizePaniniUsername(raw)
    if (!username) {
      return NextResponse.json(
        { error: "That doesn't look like a Panini username (2–16 letters, numbers, . _ -).", code: "bad_request", retryable: false },
        { status: 400 },
      )
    }
  }
  try {
    const db = supabaseAdmin as any
    const [res, coverage] = await Promise.all([
      boundedRead(db.rpc("panini_set_progress", { p_username: username }), "panini-set-progress"),
      readPaniniCoverage(db, "api/panini-set-progress"),
    ])
    if (res.error) return apiErrorResponse(res.error, "api/panini-set-progress", "Set progress is unavailable right now.")
    if (!Array.isArray(res.data)) {
      return apiErrorResponse(new Error("panini_set_progress returned a non-array"), "api/panini-set-progress", "Set progress is unavailable right now.")
    }
    const sets = (res.data as unknown[]).map(parsePaniniSetRow).filter((s): s is NonNullable<typeof s> => s !== null)
    // A malformed row is dropped by the parser; if ANY was, the list is not the
    // complete set list and must not be served as one.
    if (sets.length !== res.data.length) {
      return apiErrorResponse(
        new Error(`panini_set_progress: ${res.data.length - sets.length} malformed row(s)`),
        "api/panini-set-progress",
        "Set progress is unavailable right now.",
      )
    }
    const ownedTotal = sets.reduce((n, s) => n + s.owned, 0)
    const lastSeen = sets.reduce<string | null>((m, s) => (s.ownerLastSeenAt && (!m || s.ownerLastSeenAt > m) ? s.ownerLastSeenAt : m), null)
    return NextResponse.json(
      {
        username,
        // Only meaningful with a username: did RPC ever see a card under it?
        userSeen: username ? ownedTotal > 0 : null,
        userLastSeenAt: username ? lastSeen : null,
        sets,
        coverage: coverage.ok ? coverage.coverage : null,
        coverage_error: !coverage.ok,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": username ? "private, no-store" : "public, s-maxage=300, stale-while-revalidate=600" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/panini-set-progress", "Set progress is unavailable right now.")
  }
}
