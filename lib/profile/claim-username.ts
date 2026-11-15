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
import { ownersOfAddress } from "@/lib/wallet/wallet-owner"

export type ClaimOutcome =
  | { claimed: true; handle: string }
  | {
      claimed: false
      reason:
        | "already_set" // the collector already has a handle — theirs wins
        | "taken" // someone else holds it
        | "unusable" // the Top Shot name can't become a legal handle
        | "unproven" // the wallet belongs to another account (proved there, or saved there first) — A-1 / 11-15
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
  /** Deep audit A-1: false = the wallet is not proven for this account, so never WRITE a handle
   *  (an existing handle is still reported). Defaults to true for callers that hold a proof. */
  opts: { proven: boolean } = { proven: true },
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
    if (!opts.proven) return { claimed: false, reason: "unproven" }

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

/**
 * Is `walletAddress` a Flow account this user has PROVEN they control?
 *
 * Deep audit 2026-11-15 A-1 (Trevor: "Proof required"): a pasted Top Shot username
 * or address is a public IDENTIFIER, not ownership, so it must never hand out that
 * collector's public handle. The proofs RPC already records are the Trade Block
 * wallet signature (`trade_block_wallets`) and a signed trade-room side
 * (`trade_room_sides`); either names the account (`source`) the signer controls.
 *
 * FAILS CLOSED: a failed read is `false` — a handle is a nice-to-have, and an
 * outage must not become a window in which handles are handed out unproven.
 */
export async function isWalletProvenForUser(
  db: { from: (t: string) => any },
  userId: string,
  walletAddress: string,
): Promise<boolean> {
  const addr = (walletAddress ?? "").trim().toLowerCase()
  if (!/^0x[0-9a-f]{16}$/.test(addr)) return false
  try {
    const [block, rooms] = await Promise.all([
      db.from("trade_block_wallets").select("source").eq("user_id", userId).eq("source", addr).not("proven_at", "is", null).limit(1),
      db.from("trade_room_sides").select("source").eq("user_id", userId).eq("source", addr).not("proven_at", "is", null).limit(1),
    ])
    if (block?.error || rooms?.error) return false
    return (Array.isArray(block?.data) && block.data.length > 0) || (Array.isArray(rooms?.data) && rooms.data.length > 0)
  } catch {
    return false
  }
}

/**
 * Does `walletAddress` belong to this user under RPC's ONE ownership rule?
 *
 * 2026-11-15 (Trevor, after the A-1 "Proof required" ship): "We should let them
 * have access until we can verify easily and effectively." Measured that day: of
 * 57 accounts with a saved wallet only 2 had EVER proven one (both in June), and
 * no self-serve proof path is easy enough to expect collectors to use. So the
 * handle gate falls back to the rule every other private surface already uses
 * (lib/wallet/wallet-owner.ts, known-issues #176): a user who PROVED the address
 * owns it, else a user who VERIFIED it, else the user who saved it FIRST.
 *
 * What this keeps from A-1: a stranger who pastes a collector's name AFTER that
 * collector saved their wallet does NOT get the handle (they are not the first
 * saver). What it gives up until verification is easy: the first saver of a
 * never-saved wallet wins its handle. A wallet proven by another account always
 * beats a first save.
 *
 * FAILS CLOSED: any failed read is `false`.
 */
export async function isWalletOwnedByUser(
  db: { from: (t: string) => any },
  userId: string,
  walletAddress: string,
): Promise<boolean> {
  const addr = (walletAddress ?? "").trim().toLowerCase()
  if (!/^0x[0-9a-f]{16}$/.test(addr)) return false
  if (await isWalletProvenForUser(db, userId, addr)) return true
  try {
    const [saved, block, rooms] = await Promise.all([
      db.from("saved_wallets").select("id, user_id, verified_at").in("wallet_addr", [addr, addr.slice(2)]),
      db.from("trade_block_wallets").select("user_id").eq("source", addr).not("proven_at", "is", null).limit(1),
      db.from("trade_room_sides").select("user_id").eq("source", addr).not("proven_at", "is", null).limit(1),
    ])
    if (saved?.error || block?.error || rooms?.error) return false
    // Someone else PROVED this wallet (we already know it isn't this user): theirs.
    const provenElsewhere =
      (Array.isArray(block?.data) && block.data.length > 0) || (Array.isArray(rooms?.data) && rooms.data.length > 0)
    if (provenElsewhere) return false
    return Array.isArray(saved?.data) && ownersOfAddress(saved.data).includes(userId)
  } catch {
    return false
  }
}

/**
 * After a wallet proof lands: give the user the handle derived from that wallet's
 * known Top Shot username (`wallet_usernames`), under the same never-overwrite /
 * never-steal rules. Fail soft — a proof must never fail because of the handle.
 */
export async function claimHandleForProvenWallet(
  db: { from: (t: string) => any },
  userId: string,
  walletAddress: string,
): Promise<ClaimOutcome> {
  try {
    const addr = (walletAddress ?? "").trim().toLowerCase()
    const { data, error } = await db
      .from("wallet_usernames")
      .select("username")
      .in("wallet_addr", [addr, addr.replace(/^0x/, "")])
      .limit(1)
    if (error) return { claimed: false, reason: "error" }
    const name = (Array.isArray(data) ? data[0] : null)?.username
    if (typeof name !== "string" || !name.trim()) return { claimed: false, reason: "unusable" }
    const first = await claimUsernameFromTopShot(db, userId, name.trim())
    if (first.claimed || first.reason !== "taken" || !first.handle) return first
    // 2026-11-15 claim-then-release: handles go to the FIRST SAVER until verification
    // is easy (isWalletOwnedByUser), so a proof must be able to take a handle back
    // from an account that only got it by saving this wallet unproven.
    if (!(await releaseHandleFromUnprovenHolder(db, userId, addr, first.handle))) return first
    return await claimUsernameFromTopShot(db, userId, name.trim())
  } catch {
    return { claimed: false, reason: "error" }
  }
}

/**
 * Clear `handle` from the account holding it, ONLY when that account got it from
 * this wallet without proof: it saved this wallet, never verified it, and never
 * proved it. A handle chosen by hand for an unrelated wallet is never touched.
 * Every read must SUCCEED to release — any error is `false` (nothing changes).
 */
export async function releaseHandleFromUnprovenHolder(
  db: { from: (t: string) => any },
  proverId: string,
  walletAddress: string,
  handle: string,
): Promise<boolean> {
  const addr = (walletAddress ?? "").trim().toLowerCase()
  if (!/^0x[0-9a-f]{16}$/.test(addr) || !handle) return false
  try {
    const { data: holderRow, error: hErr } = await db
      .from("profile_bio")
      .select("user_id")
      .eq("username", handle)
      .maybeSingle()
    if (hErr) return false
    const holder = holderRow?.user_id
    if (typeof holder !== "string" || holder === proverId) return false
    const [saved, block, rooms] = await Promise.all([
      db.from("saved_wallets").select("id, verified_at").eq("user_id", holder).in("wallet_addr", [addr, addr.slice(2)]),
      db.from("trade_block_wallets").select("user_id").eq("user_id", holder).eq("source", addr).not("proven_at", "is", null).limit(1),
      db.from("trade_room_sides").select("user_id").eq("user_id", holder).eq("source", addr).not("proven_at", "is", null).limit(1),
    ])
    if (saved?.error || block?.error || rooms?.error) return false
    const savedRows = Array.isArray(saved?.data) ? saved.data : []
    if (savedRows.length === 0) return false // the handle did not come from this wallet
    if (savedRows.some((r: { verified_at?: unknown }) => r?.verified_at != null)) return false
    if ((Array.isArray(block?.data) && block.data.length > 0) || (Array.isArray(rooms?.data) && rooms.data.length > 0)) return false
    const { error: uErr } = await db
      .from("profile_bio")
      .update({ username: null, updated_at: new Date().toISOString() })
      .eq("user_id", holder)
      .eq("username", handle)
    return !uErr
  } catch {
    return false
  }
}
