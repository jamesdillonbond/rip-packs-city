// lib/auth/owner-key-guard.ts
//
// ── What this closes ────────────────────────────────────────────────────────
// `owner_key` / `ownerKey` is a CLIENT-CONTROLLED value. It is read straight
// out of `localStorage` (see lib/owner-key.ts, key `rpc_owner_key`) and sent up
// as a query param or a JSON body field. There is NO server-side
// owner_key -> user_id mapping table, and nothing about the value is signed,
// scoped, or session-derived — it is just a string the browser chose to send.
//
// Several routes then handed that string to the SERVICE-ROLE client as the row
// selector (`.eq("owner_key", ownerKey)` for reads, `.upsert({ owner_key })` /
// `.delete().eq("owner_key", ...)` for writes). The service-role client bypasses
// RLS, so the request param WAS the authorization decision. Anyone who knew (or
// guessed, or read off a public profile) another user's key could read that
// user's private watchlist, add/remove rows in it, overwrite their portfolio
// snapshot history, or re-point their saved wallet — a textbook IDOR.
//
// ── The fix ─────────────────────────────────────────────────────────────────
// `owner_key` is POLYMORPHIC — measured against live data 2026-08-01, the same
// column holds three different shapes depending on which surface wrote it:
//
//   * an auth user UUID   — every row in `portfolio_snapshots` (1,217 rows / 22 keys)
//   * a public username   — `profile_bio.username`
//   * a 0x Flow address   — what `lib/owner-key.ts`'s localStorage key actually
//                           holds after collection/page.tsx overwrites it with
//                           the resolved wallet address, and
//                           therefore what WalletHydrator sends to /api/wallet/profile
//
// So a guard that resolves ONLY against `profile_bio.username` would 403 the
// live, legitimate wallet-hydration and watchlist paths. This guard bridges all
// three namespaces, in cheapest-first order:
//
//   1. requires a real session (401 otherwise);
//   2. `ownerKey` IS the caller's own user id            -> allow (no query);
//   3. `ownerKey` is a wallet address in `saved_wallets` -> allow iff that row's
//      user_id is the caller, else 403 (all 94 rows carry a user_id);
//   4. `ownerKey` is claimed as a `profile_bio.username` -> allow iff the
//      claimant is the caller, else 403;
//   5. otherwise the key is unclaimed in every namespace -> 403, with one
//      narrow first-write exception documented at that branch.
//
// Unclaimed keys are rejected too, with ONE narrow exception documented at the
// `unclaimed` branch below (a brand-new user who has not picked a username yet
// still has to be able to write). Every failure mode — including a DB error
// resolving the claimant — FAILS CLOSED with 403. A guard that opens on error
// is not a guard.
//
// Usage in a route handler:
//
//   const gate = await requireOwnedKey(ownerKey)
//   if (gate instanceof Response) return gate
//   // gate.user is the authenticated caller, and ownerKey is provably theirs
//
// Precedent for the shape of this fix: app/api/profile/teams/route.ts (the
// 2026-07-29 teams IDOR fix), which resolves the body ownerKey through
// profile_bio and rejects any value that does not resolve to the caller.

import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export type OwnedKeyGate = { user: User } | Response

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Verify that the authenticated caller owns `ownerKey`.
 *
 * Returns `{ user }` when the key provably belongs to the session user, or a
 * ready-to-return `Response` (401 unauthenticated / 403 not yours) otherwise.
 * Never throws for the auth outcome — callers just `return` the Response.
 */
export async function requireOwnedKey(ownerKey: string): Promise<OwnedKeyGate> {
  const key = typeof ownerKey === "string" ? ownerKey.trim() : ""

  const user = await getCurrentUser()
  if (!user) {
    return deny(401, "Authentication required")
  }

  // Defensive: routes validate presence themselves and return their own 400,
  // so an empty key should never reach here. If one does, fail closed rather
  // than letting an empty selector through to a service-role query.
  if (!key) {
    return deny(403, "Forbidden")
  }

  // ── Bridge 1: the key IS the caller's auth user id ──────────────────────
  // `portfolio_snapshots` is keyed this way. Pure string compare, no query.
  if (key.toLowerCase() === user.id.toLowerCase()) {
    return { user }
  }

  // ── Bridge 2: the key is a Flow wallet address ──────────────────────────
  // `saved_wallets` is the ownership record for addresses (user_id + wallet_addr;
  // it is already the authorization source for /api/wallet/pack-summary). Only
  // probe it for address-shaped keys so a username can never be resolved here.
  if (/^0x[0-9a-fA-F]{16}$/.test(key)) {
    const addr = key.toLowerCase()
    const { data: walletRows, error: walletErr } = await (supabaseAdmin as any)
      .from("saved_wallets")
      .select("user_id")
      .eq("wallet_addr", addr)

    if (walletErr) {
      // FAIL CLOSED — we could not determine ownership.
      console.error("[requireOwnedKey] saved_wallets lookup failed", walletErr)
      return deny(403, "Forbidden")
    }

    const owners = (walletRows ?? [])
      .map((r: any) => r?.user_id)
      .filter((id: unknown): id is string => typeof id === "string")

    if (owners.length > 0) {
      // The address is claimed. Allow only if the caller is one of its owners.
      // (A wallet may legitimately be saved by several users — pinning someone
      // else's wallet is a supported read — so membership, not equality.)
      return owners.includes(user.id) ? { user } : deny(403, "Forbidden")
    }
    // Unclaimed address: fall through to the unclaimed branch below, which
    // permits a first write only for a caller with no identity of their own.
  }

  // ── Who claims this key? ────────────────────────────────────────────────
  // Case-insensitive, matching how every other ownerKey-driven endpoint in the
  // repo resolves a public username (profile/teams, profile/trophy-slabs, ...).
  //
  // NOTE on `ilike`: PostgREST treats `%` / `*` in the pattern as wildcards, so
  // `ilike` alone would let a crafted key ("tre%") match a DIFFERENT user's row.
  // That is why the returned username is re-compared EXACTLY (case-insensitively)
  // below before it is honoured as a claim — a wildcard "match" is therefore
  // never treated as ownership. A pattern matching MULTIPLE rows makes
  // maybeSingle() error, which also fails closed.
  const { data: claimant, error: claimantErr } = await (supabaseAdmin as any)
    .from("profile_bio")
    .select("user_id, username")
    .ilike("username", key)
    .maybeSingle()

  if (claimantErr) {
    // FAIL CLOSED. We could not determine ownership, so we must not assume it.
    console.error("[requireOwnedKey] claimant lookup failed", claimantErr)
    return deny(403, "Forbidden")
  }

  const claimantId: string | null = claimant?.user_id ?? null
  const claimantName: string | null =
    typeof claimant?.username === "string" ? claimant.username : null
  const isExactClaim =
    !!claimantId &&
    !!claimantName &&
    claimantName.trim().toLowerCase() === key.toLowerCase()

  if (isExactClaim) {
    if (claimantId !== user.id) {
      // The key belongs to somebody else. This is the IDOR case.
      return deny(403, "Forbidden")
    }
    return { user }
  }

  // ── Unclaimed key ───────────────────────────────────────────────────────
  // Nobody owns this key (no profile_bio row matches it). Default is STILL a
  // 403: an unclaimed key is not evidence that it is the caller's, and letting
  // any signed-in user write arbitrary unclaimed keys would leave rows that a
  // future owner of that username would inherit.
  //
  // The ONE exception: a brand-new account that has not chosen a username yet
  // has nothing in profile_bio to match against, so a strict rule would lock it
  // out of its own first write (saving a wallet, starting a watchlist). If the
  // session user has no username of their own, we let the write through — they
  // cannot be stepping on a claimed key, because we just proved no claim exists.
  // As soon as they claim a username, this branch stops applying to them and the
  // exact-match rule above takes over.
  const { data: self, error: selfErr } = await (supabaseAdmin as any)
    .from("profile_bio")
    .select("username")
    .eq("user_id", user.id)
    .maybeSingle()

  if (selfErr) {
    // FAIL CLOSED, same reasoning as above.
    console.error("[requireOwnedKey] self lookup failed", selfErr)
    return deny(403, "Forbidden")
  }

  const selfUsername =
    typeof self?.username === "string" ? self.username.trim() : ""

  if (selfUsername) {
    // Caller already has their own username — an unclaimed key is not theirs.
    return deny(403, "Forbidden")
  }

  return { user }
}
