// Whose moments a /api/profile/{top-moments,hero-moment} call may read (2026-11-14).
//
// ⛔ PRIVACY. These routes return `get_user_top_owned_moments(p_user_id)` — every moment across
// a user's saved wallets WITH each `wallet_address`, plus linked Panini cards. They resolved ANY
// `?ownerKey=<username|address>` to that user with no ownership check, so any signed-in caller
// could page through another collector's holdings and private wallet addresses — the very fields
// lib/profile/public-profile.ts strips as a "load-bearing privacy step". And the address branch
// took `.limit(1)` of `saved_wallets` by address with no user filter: an ARBITRARY saver (anyone
// may save any address), so a viewer's own dashboard could be answered with someone else's.
//
// Every in-app caller (dashboard, trophy / hero / avatar pickers) asks about the VIEWER. So:
//   · the caller must be signed in (401 otherwise);
//   · an ownerKey that is one of the VIEWER's saved wallets, or the viewer's own username, is the
//     viewer;
//   · an ownerKey that resolves to ANOTHER user is 403 — never their data, never the viewer's
//     under their name;
//   · an ownerKey that resolves to nobody is the viewer (the documented fallback), or 404 with
//     ?strict=1 (#148).
// A failed read is a failure (5xx), never "nobody".

import { getCurrentUser } from "@/lib/auth/supabase-server"
import { boundedRead } from "@/lib/api/bounded-read"
import { isSupportedAddress, normalizeAddress } from "@/lib/address"

export type OwnOwner =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403 | 404; error: string }
  | { ok: false; status: 500; cause: unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveOwnOwner(db: any, ownerKey: string | null, strict: boolean, tag: string): Promise<OwnOwner> {
  const user = await getCurrentUser()
  if (!user?.id) return { ok: false, status: 401, error: "Authentication required" }
  const key = (ownerKey ?? "").trim()
  if (!key) return { ok: true, userId: user.id }

  if (isSupportedAddress(key)) {
    const addr = normalizeAddress(key)
    const mine = await boundedRead(
      db.from("saved_wallets").select("user_id").eq("wallet_addr", addr).eq("user_id", user.id).limit(1),
      `${tag}/saved_wallets:mine`,
    )
    if (mine.error) return { ok: false, status: 500, cause: mine.error }
    if (Array.isArray(mine.data) && mine.data.length > 0) return { ok: true, userId: user.id }
    const anyone = await boundedRead(
      db.from("saved_wallets").select("user_id").eq("wallet_addr", addr).limit(1),
      `${tag}/saved_wallets:any`,
    )
    if (anyone.error) return { ok: false, status: 500, cause: anyone.error }
    if (Array.isArray(anyone.data) && anyone.data.length > 0) {
      return { ok: false, status: 403, error: "forbidden_cross_user" }
    }
  }

  const bio = await boundedRead(
    db.from("profile_bio").select("user_id").eq("username", key).maybeSingle(),
    `${tag}/profile_bio`,
  )
  if (bio.error) return { ok: false, status: 500, cause: bio.error }
  const owner = (bio.data as { user_id?: string } | null)?.user_id
  if (owner) return owner === user.id ? { ok: true, userId: user.id } : { ok: false, status: 403, error: "forbidden_cross_user" }

  if (strict) return { ok: false, status: 404, error: "owner_not_found" }
  return { ok: true, userId: user.id }
}
