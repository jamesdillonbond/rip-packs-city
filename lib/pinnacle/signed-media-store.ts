// lib/pinnacle/signed-media-store.ts
//
// 2026-11-25: the last signed Dapper CDN url per (render_id, variant), so /api/public/pinnacle-image
// does not have to read disneypinnacle.com's edition page on every cold request. That page is the only
// live source (studio-platform GraphQL answers 530 since ~11-17) and its tail reaches the 10 s timeout
// in the evening, past Vercel's ~7 s image-optimizer give-up and the OG builder's 4.5 s art budget —
// Pinnacle share cards lost their art. Signatures live ~24 h, so one page read serves a pin all day.
//
// Table: public.pinnacle_signed_media (audit_20261125_pinnacle_signed_media_cache), service-role only.
// Every function here NEVER throws: a store that cannot be read is a miss, one that cannot be written
// is skipped — the route then behaves exactly as it did before the store existed.

import { supabaseAdmin } from "@/lib/supabase"

export type SignedMediaVariant = "front" | "quarter" | "thumb"
export type SignedMediaSource = "gql" | "edition-page"

export interface StoredSignedMedia {
  url: string
  /** Unix seconds. */
  exp: number
}

const TABLE = "pinnacle_signed_media"
const READ_TIMEOUT_MS = 1_500
const WRITE_TIMEOUT_MS = 2_000

/** The `exp` query parameter of a signed asset url (unix seconds), or null when it has none. */
export function expOfSignedUrl(url: string): number | null {
  try {
    const raw = new URL(url).searchParams.get("exp")
    if (!raw || !/^[0-9]{9,11}$/.test(raw)) return null
    return Number(raw)
  } catch {
    return null
  }
}

export async function readSignedMedia(renderId: string, variant: SignedMediaVariant): Promise<StoredSignedMedia | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from(TABLE)
      .select("url, expires_at")
      .eq("render_id", renderId)
      .eq("variant", variant)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle()
    if (error || !data || typeof data.url !== "string") return null
    const exp = Math.floor(Date.parse(String(data.expires_at)) / 1000)
    return Number.isFinite(exp) ? { url: data.url, exp } : null
  } catch {
    return null
  }
}

/** Upsert the newest signature. Returns whether it landed (never throws). */
export async function writeSignedMedia(
  renderId: string,
  variant: SignedMediaVariant,
  url: string,
  exp: number,
  source: SignedMediaSource,
): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from(TABLE)
      .upsert(
        {
          render_id: renderId,
          variant,
          url,
          expires_at: new Date(exp * 1000).toISOString(),
          source,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "render_id,variant" },
      )
      .abortSignal(AbortSignal.timeout(WRITE_TIMEOUT_MS))
    return !error
  } catch {
    return false
  }
}
