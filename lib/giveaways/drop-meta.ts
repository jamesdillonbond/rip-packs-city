// lib/giveaways/drop-meta.ts
//
// The giveaway page's link-preview metadata read (2026-11-10, the Dame Time
// reward packs on X). Kept out of the page so the server page does no inline
// database access (__tests__/server-page-data-access-ratchet.test.ts).
//
// Three answers: a named drop · null (no such drop, a draft, no title) · a
// failed read, which also answers null — the page then shows the generic
// title, never a drop that may not exist.

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"

const SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/

export async function giveawayMeta(slug: string): Promise<{ title: string; gated: boolean } | null> {
  if (!SLUG.test(slug)) return null
  try {
    const { data, error } = await boundedRead(
      supabaseAdmin.from("giveaway_drops").select("title, status, eligible_challenge_id").eq("slug", slug).maybeSingle(),
      "giveaways/[slug] metadata",
    )
    const row = data as { title?: unknown; status?: unknown; eligible_challenge_id?: unknown } | null
    if (error || !row || row.status === "draft" || typeof row.title !== "string" || !row.title.trim()) return null
    return { title: row.title.trim(), gated: row.eligible_challenge_id != null }
  } catch {
    return null
  }
}
