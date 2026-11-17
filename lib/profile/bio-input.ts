// lib/profile/bio-input.ts
//
// Validation for the three profile_bio fields a user can set that something ELSE
// then trusts (CISO pass 2026-11-04, API authorization findings 1 and 8):
//
//   username     — decides who owns every owner_key-keyed private row (requireOwnedKey)
//                  and which /profile/<handle> URL is theirs. Before 11-04 POST/PATCH
//                  /api/profile/bio accepted any string. Now: the SAME rule the Top Shot
//                  auto-claim applies (lib/profile/username-from-topshot.ts: lowercase
//                  [a-z0-9_-]{3,32}, not reserved, not blocklisted). A DB CHECK and a
//                  case-insensitive unique index back it (migration 20261104174500).
//   accent_color — rendered into an inline `style`; must be a hex colour.
//   avatar_url   — rendered into `img src` and fetched by the OG card from the server;
//                  must be something our CSP can display at all (canDisplayAvatarUrl),
//                  which also bounds what the server will ever fetch.
//
// Each check returns a user-facing reason, never throws; the route turns it into 400.

import { canDisplayAvatarUrl } from "@/lib/media/avatar-proxy"
import { HANDLE_RE, RESERVED_HANDLES } from "@/lib/profile/username-from-topshot"
import { isBlocklisted } from "@/lib/user/blocklist"

export type BioFieldCheck = { ok: true; value: string | null } | { ok: false; error: string }

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** A chosen handle: lowercased, shape-checked, not reserved, not blocklisted. */
export function checkUsername(raw: unknown): BioFieldCheck {
  if (typeof raw !== "string") return { ok: false, error: "Username must be text." }
  const handle = raw.trim().toLowerCase()
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, error: "Usernames are 3–32 characters: lowercase letters, numbers, _ or -." }
  }
  if (RESERVED_HANDLES.has(handle)) return { ok: false, error: "That username is reserved." }
  if (isBlocklisted(handle)) return { ok: false, error: "That username isn't allowed." }
  return { ok: true, value: handle }
}

export function checkAccentColor(raw: unknown): BioFieldCheck {
  if (raw == null || raw === "") return { ok: true, value: null }
  if (typeof raw !== "string" || !HEX_COLOUR.test(raw.trim())) {
    return { ok: false, error: "Accent colour must be a hex colour like #E03A2F." }
  }
  return { ok: true, value: raw.trim() }
}

export function checkAvatarUrl(raw: unknown): BioFieldCheck {
  if (raw == null || raw === "") return { ok: true, value: null }
  if (typeof raw !== "string") return { ok: false, error: "Avatar must be a URL." }
  const value = raw.trim()
  if (value.length > 2048) return { ok: false, error: "That avatar URL is too long." }
  if (!canDisplayAvatarUrl(value)) {
    return { ok: false, error: "That avatar host can't be shown here. Use an https image from a collectibles site, or upload one." }
  }
  return { ok: true, value }
}
