// lib/profile/username-from-topshot.ts
//
// Derives the RPC public handle from a collector's Dapper/Top Shot username.
//
// WHY THIS EXISTS. `/profile/<username>` only exists once `profile_bio.username`
// is set, and nothing set it except a manual visit to /profile/edit — so as of
// 2026-08-13, 16 of 20 signed-up collectors had NO public profile at all:
// nothing to personalise, nothing to share, and every improvement to the
// profile page and its social card invisible to them. Meanwhile every one of
// those 20 had already told us their Dapper username to load their collection.
//
// The convention this encodes is not invented. All four collectors who set a
// handle by hand chose exactly the normalization below (alxo, jamesdillonbond,
// tetrislblock, tomwagmi — each the lowercased form of their Top Shot name), so
// defaulting to it matches what people already do rather than imposing a scheme.
//
// ⚠ OWNERSHIP IS NOT PROVEN HERE, and that is a pre-existing property of the
// product, not something this module introduces. The dashboard field resolves
// ANY Dapper username to its public wallet — that is the point, it is a
// read-only lookup — and /profile/edit already lets a signed-in user type any
// handle they like with no check at all. So a handle claimed through this path
// is exactly as (un)verified as one typed by hand: first-come, first-served.
// The separate listing-challenge flow is what actually proves wallet ownership.
// If handle-squatting ever matters, the fix is to RESERVE handles that match a
// Top Shot username for the verified owner — a product decision, not a
// normalization one.

import { isBlocklisted } from "@/lib/user/blocklist"

/** Mirrors USERNAME_RE in app/profile/edit/page.tsx — the handle contract. */
export const HANDLE_RE = /^[a-z0-9_-]{3,32}$/

/**
 * Handles that must never be auto-claimed.
 *
 * ⚠ `edit` and `settings` are not merely rude to take — they are REAL PATH
 * SEGMENTS. `app/profile/edit` is a static route, and in Next.js a static
 * segment beats the `[username]` dynamic one, so a collector auto-assigned the
 * handle "edit" would get a profile at a URL that can never render their
 * profile. `settings` is disallowed in robots.ts for the same historical
 * reason. The rest are reserved because an auto-claim should not hand out an
 * identity that reads as official.
 */
export const RESERVED_HANDLES = new Set([
  "edit",
  "settings",
  "admin",
  "api",
  "auth",
  "login",
  "logout",
  "dashboard",
  "profile",
  "support",
  "help",
  "rpc",
  "rippackscity",
  "official",
  "moderator",
  "staff",
  "system",
  "null",
  "undefined",
])

export type HandleRejection =
  | "empty"
  | "too_short"
  | "too_long"
  | "reserved"
  | "blocklisted"

export type HandleResult =
  | { ok: true; handle: string }
  | { ok: false; reason: HandleRejection }

/**
 * Normalize a Dapper/Top Shot username into an RPC handle.
 *
 * Lowercases and drops any character the handle contract does not allow
 * (`Banana_Boat` → `banana_boat`, `BLAISE_27` → `blaise_27`). Length is checked
 * AFTER stripping, because a name made mostly of punctuation can pass a raw
 * length check and then normalize to two characters.
 *
 * ⚠ Over-long names are TRUNCATED rather than rejected: the 32-char ceiling is
 * ours, not Dapper's, and refusing a valid collector a handle because their
 * name is long would leave exactly the people this exists to help without a
 * profile. Truncation can create a collision, which the caller already has to
 * handle for the ordinary case.
 */
export function handleFromTopShotUsername(raw: string | null | undefined): HandleResult {
  const stripped = (raw ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "")
  if (!stripped) return { ok: false, reason: "empty" }
  if (stripped.length < 3) return { ok: false, reason: "too_short" }

  const handle = stripped.slice(0, 32)

  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved" }
  // Runs on the TRUNCATED handle, i.e. the string we would actually publish —
  // checking the pre-truncation form could clear a name whose visible handle is
  // the offending substring.
  if (isBlocklisted(handle)) return { ok: false, reason: "blocklisted" }
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: "too_short" }

  return { ok: true, handle }
}
