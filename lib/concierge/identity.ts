// lib/concierge/identity.ts
//
// Who the concierge is talking to, beyond the auth cookie (2026-11-10).
//
// allow_list is the beta-era roster. Accounts created through sign-up since
// October have NO row there (23 of 24 measured 11-10), so every new member read
// as "signed in, no username": get_my_feedback_status told a signed-in
// collector to sign in, and the feedback they logged carried no owner_key.
// The fallback is the account's OWN profile row, keyed by the auth uid from
// the verified cookie (user_profiles.username is UNIQUE).

type ProfileReader = {
  from: (table: string) => any
}

/** The signed-in account's RPC username (user_profiles.id = auth uid), lower-cased
 *  to match allow_list-era owner_key values. A failed read is null ("unknown"),
 *  never a guess. */
export async function profileUsernameFor(db: ProfileReader, userId: string): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("user_profiles")
      .select("username, topshot_username")
      .eq("id", userId)
      .limit(1)
      .maybeSingle()
      .abortSignal(AbortSignal.timeout(1500))
    if (error || !data) return null
    const name = String(data.username || data.topshot_username || "").trim().toLowerCase()
    return name || null
  } catch {
    return null
  }
}

/** PostgREST `or=` filter for "this caller's feedback rows": their username OR
 *  their verified account email (rows logged before the fallback, and relayed
 *  rows the team logs, carry the email but no owner_key). Values are
 *  double-quoted (an email carries `.` and `@`); a `"` or `\` is dropped, not
 *  escaped — neither occurs in a username or a verified email, and dropping can
 *  only narrow the match. With neither value the filter matches nothing, so no
 *  caller can ever read every row through it. */
export function feedbackOwnerFilter(ownerKey: string | null | undefined, email: string | null | undefined): string {
  const q = (v: string) => `"${v.replace(/["\\]/g, "")}"`
  const parts: string[] = []
  if (ownerKey && ownerKey.trim()) parts.push(`owner_key.eq.${q(ownerKey.trim())}`)
  if (email && email.trim()) parts.push(`user_email.eq.${q(email.trim())}`)
  return parts.length ? parts.join(",") : "id.eq.-1"
}
