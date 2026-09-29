// lib/giveaways/draft-input.ts
//
// Validation for the admin "create draft" body (app/api/admin/giveaways POST).
// The database re-checks everything (create_giveaway_draft); this exists so the
// operator gets a specific message before a round trip.

import type { DraftInput } from "@/lib/giveaways/store"

export const FLOW_WALLET = /^0x[0-9a-f]{16}$/

/** Validate a draft body. Returns the input or a message for the operator. */
export function parseDraftBody(body: unknown): DraftInput | string {
  if (!body || typeof body !== "object") return "body must be a JSON object"
  const b = body as Record<string, unknown>
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "")
  const int = (k: string) => (typeof b[k] === "number" && Number.isInteger(b[k]) ? (b[k] as number) : NaN)
  const slug = str("slug").toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(slug)) return "slug: 3-60 chars, lowercase letters, digits and dashes"
  const title = str("title")
  if (title.length < 3 || title.length > 120) return "title: 3-120 characters"
  const sponsor_name = str("sponsor_name")
  if (sponsor_name.length < 2 || sponsor_name.length > 80) return "sponsor_name: 2-80 characters"
  const description = str("description")
  if (description.length > 2000) return "description: at most 2000 characters"
  const admin_wallet = str("admin_wallet").toLowerCase()
  if (!FLOW_WALLET.test(admin_wallet)) return "admin_wallet must be a Flow 0x address"
  const pack_count = int("pack_count")
  if (!(pack_count >= 1 && pack_count <= 100)) return "pack_count: 1-100"
  const moments_per_pack = int("moments_per_pack")
  if (!(moments_per_pack >= 1 && moments_per_pack <= 10)) return "moments_per_pack: 1-10"
  const ids = Array.isArray(b.moment_ids) ? b.moment_ids.map((x) => String(x).trim()) : null
  if (!ids || ids.some((id) => !/^[0-9]{1,20}$/.test(id))) return "moment_ids must be a list of numeric moment ids"
  if (ids.length !== pack_count * moments_per_pack) {
    return `${ids.length} moments selected; ${pack_count} packs of ${moments_per_pack} need ${pack_count * moments_per_pack}`
  }
  return { slug, title, description: description || null, sponsor_name, admin_wallet, pack_count, moments_per_pack, moment_ids: ids }
}

