// app/api/og/player/route.tsx
// Branded per-player OG card. GET /api/og/player?collection=<slug>&slug=<playerSlug>
//
// ⚠ THE ART ON THIS CARD IS A FALLBACK CHAIN, NOT A SINGLE VALUE, and it has to
// be. `players.headshot_url` is null for 0 of 3,869 rows (live read 2026-09-13),
// so `get_player_editions` art is the ONLY art any player card has ever had —
// and asking that RPC for ONE row published a blank card whenever that one url
// was dead. LeBron James' top-FMV edition art answers 404 today while his next
// two candidates answer 206; 24 of 24 sampled thumbnails were live, so this is a
// sparse dead-url problem, which is exactly the shape a fallback fixes and a
// bigger limit alone does not. See lib/og/img-data.ts → ogImageDataUriFirst for
// why the walk is sequential (one fetch in the common case) and what budget it
// spends.
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { getCollection } from "@/lib/collections"
import { renderEntityOg } from "@/lib/og/entity-card"
import { ogImageDataUriFirst } from "@/lib/og/img-data"
import { boundedRead } from "@/lib/api/bounded-read"
import { OG_FETCH_TIMEOUT_MS } from "@/lib/og/og-fetch"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * How many edition thumbnails to carry as art candidates.
 *
 * ⚠ A COST CEILING, NOT A COUNT OF WHAT WE FETCH. The walk stops at the first
 * candidate that resolves, so a live top edition still costs exactly one fetch;
 * this is the number of tries available before the card falls back to its
 * no-media tile. Four because the sibling montage cards (set / team / series)
 * already ask for four and the RPC's own `LIMIT` makes the extra rows free next
 * to the read it already does.
 */
const ART_CANDIDATES = 4

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const collection = sp.get("collection") || ""
  const slug = sp.get("slug") || ""
  const coll = getCollectionByUrlSlug(collection)
  const accent = getCollection(collection)?.accent ?? null
  const label = coll?.displayName ?? "Rip Packs City"
  if (!coll || !slug) return renderEntityOg({ eyebrow: "RIP PACKS CITY", title: label, images: [], accent })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  let detail: Record<string, any> | null = null
  let thumbs: Array<string | null> = []
  try {
    const [d, eds] = await Promise.all([
      boundedRead(sb.rpc("get_player_detail", { p_collection_id: coll.id, p_player_slug: slug }), "og/player/get_player_detail", OG_FETCH_TIMEOUT_MS),
      boundedRead(sb.rpc("get_player_editions", { p_collection_id: coll.id, p_player_slug: slug, p_limit: ART_CANDIDATES, p_offset: 0 }), "og/player/get_player_editions", OG_FETCH_TIMEOUT_MS),
    ])
    detail = Array.isArray(d.data) ? (d.data[0] ?? null) : (d.data ?? null)
    if (Array.isArray(eds.data)) thumbs = eds.data.map((r: Record<string, any> | null) => r?.thumbnail_url ?? null)
  } catch { /* fall through */ }

  if (!detail) return renderEntityOg({ eyebrow: label.toUpperCase(), title: "Player", images: [], accent })

  const isCharacter = detail.is_character === true
  // The headshot first when there ever is one, then editions in FMV order.
  // Already a data URI by the time it reaches the card, which renderEntityOg
  // passes through untouched — so the single-hero layout is preserved rather
  // than turning into a 4-tile montage the moment a fallback is available.
  const portrait = await ogImageDataUriFirst([detail.headshot_url ?? null, ...thumbs])
  const editions = detail.edition_count != null ? Number(detail.edition_count) : null
  return renderEntityOg({
    eyebrow: `${label.toUpperCase()} · ${isCharacter ? "CHARACTER" : "PLAYER"}`,
    title: detail.name ?? "Player",
    subtitle: detail.team ?? null,
    accent,
    images: portrait ? [portrait] : [],
    statLabel: editions ? "Editions" : null,
    statValue: editions ? editions.toLocaleString() : null,
  })
}
