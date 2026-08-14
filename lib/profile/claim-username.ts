// lib/profile/claim-username.ts
//
// Claims the RPC public handle for a collector from their Dapper/Top Shot
// username, on the path where we first learn it.
//
// Separated from the normalization (lib/profile/username-from-topshot.ts) so
// the string rules stay pure and unit-testable, and the DB rules — never
// overwrite, never steal, never fail the caller — live in one place with the
// write.

import { handleFromTopShotUsername } from "@/lib/profile/username-from-topshot"

export type ClaimOutcome =
  | { claimed: true; handle: string }
  | {
      claimed: false
      reason:
        | "already_set" // the collector already has a handle — theirs wins
        | "taken" // someone else holds it
        | "unusable" // the Top Shot name can't become a legal handle
        | "error" // the read/write failed; nothing was changed
      handle?: string
    }

/**
 * Give `userId` the handle derived from `topShotUsername`, if it is free.
 *
 * THREE rules, all deliberate:
 *
 * 1. NEVER OVERWRITE. A handle the collector chose — or that a previous claim
 *    set — is their identity and the URL other people have already shared. A
 *    re-resolve of the same wallet must be a no-op, and this function is called
 *    from a path collectors re-run whenever they refresh their collection.
 *
 * 2. NEVER STEAL. `profile_bio.username` is UNIQUE, so a taken handle raises
 *    23505. That is caught and reported, not suffixed: silently handing someone
 *    `rigged2` because a squatter holds `rigged` presents a consolation prize
 *    as if it were their name. The caller surfaces the outcome so the collector
 *    can pick one instead.
 *
 * 3. NEVER FAIL THE CALLER. This runs inside wallet association — the primary
 *    "load my collection" path. A handle is a nice-to-have; the wallet rows are
 *    the point. Every failure resolves to an outcome, never a throw.
 */
export async function claimUsernameFromTopShot(
  db: {
    from: (t: string) => any
  },
  userId: string,
  topShotUsername: string | null | undefined,
): Promise<ClaimOutcome> {
  const derived = handleFromTopShotUsername(topShotUsername)
  if (!derived.ok) return { claimed: false, reason: "unusable" }
  const handle = derived.handle

  try {
    const { data: existing, error: readErr } = await db
      .from("profile_bio")
      .select("username")
      .eq("user_id", userId)
      .maybeSingle()

    // ⚠ A FAILED READ IS NOT AN ABSENT HANDLE. Treating it as absent would send
    // us into the write, where a collector who already has a handle would hit
    // the unique constraint on their OWN row's value and be reported as
    // "taken" — a confusing outcome invented from a transient error.
    if (readErr) return { claimed: false, reason: "error" }

    const current = (existing?.username ?? "").trim()
    if (current) return { claimed: false, reason: "already_set", handle: current }

    // Upsert, not update: a collector can have saved wallets before they have a
    // profile_bio row at all (measured: 1 of 21 on 2026-08-13), and an UPDATE
    // would silently match zero rows and report success.
    const { error: writeErr } = await db
      .from("profile_bio")
      .upsert(
        { user_id: userId, username: handle, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      )

    if (writeErr) {
      // 23505 on this table means the UNIQUE(username) index, since the
      // onConflict target resolves the user_id collision.
      if ((writeErr as { code?: string }).code === "23505") {
        return { claimed: false, reason: "taken", handle }
      }
      return { claimed: false, reason: "error" }
    }

    return { claimed: true, handle }
  } catch {
    return { claimed: false, reason: "error" }
  }
}
