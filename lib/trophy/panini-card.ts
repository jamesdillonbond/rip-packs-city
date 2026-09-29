// lib/trophy/panini-card.ts
//
// Server-side resolution of a Panini card a collector asks to pin to their
// trophy case (POST /api/profile/trophy).
//
// ── WHY THE SERVER DERIVES EVERY FIELD ──────────────────────────────────────
// For a Flow Moment, `get_trophy_slab_data` renders the public slab with
// `COALESCE(e.<live>, tm.<stored>)`, so a forged player/tier/FMV is overridden
// by the live `editions` row. Most Panini cards a collector holds are OUTSIDE
// the catalogued editions (146 of 146 walked cards, 2026-09-28), so for them
// there IS no live side: whatever the POST stores is exactly what their public
// profile shows. So for Panini nothing display-bearing is taken from the body —
// name, set, serial, mint, tier and art come from the walked profile / serial
// index / editions, and a stored FMV is never taken (the slab reads the live
// edition FMV where one exists, and shows none where it does not).
//
// ── OWNERSHIP ───────────────────────────────────────────────────────────────
// The card must be under a Panini username THIS user linked
// (saved_collector_identities): on the walked public profile, or the serial
// index's current owner. The same pool get_user_top_owned_moments offers the
// picker. A BURNT serial is refused.
//
// ── THREE OUTCOMES, never two ───────────────────────────────────────────────
// `{ ok: true, card }` — verified; `{ ok: true, card: null }` — read fine, the
// card is not the user's (403 upstream); `{ ok: false }` — a read FAILED (503
// upstream). A failed read must never be treated as "not yours", and never as
// "yours" either.

import { paniniAssetUrl } from "@/lib/panini/assets"
import { PANINI_COLLECTION_ID } from "@/lib/trophy/slab-href"

export interface PaniniTrophyCard {
  momentId: string
  editionId: string | null
  playerName: string | null
  setName: string | null
  serialNumber: number | null
  circulationCount: number | null
  tier: string | null
  thumbnailUrl: string | null
}

export type PaniniTrophyResolution =
  | { ok: true; card: PaniniTrophyCard | null }
  | { ok: false; error: unknown }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolvePaniniTrophyCard(db: any, userId: string, sku: string): Promise<PaniniTrophyResolution> {
  try {
    const names = await db
      .from("saved_collector_identities")
      .select("identity_value")
      .eq("user_id", userId)
      .eq("collection_id", PANINI_COLLECTION_ID)
      .eq("identity_kind", "username")
    if (names.error) return { ok: false, error: names.error }
    const usernames = ((names.data ?? []) as { identity_value: unknown }[])
      .map((r) => str(r.identity_value))
      .filter((u): u is string => u != null)
    if (usernames.length === 0) return { ok: true, card: null }

    const [held, serial] = await Promise.all([
      db
        .from("panini_user_holdings")
        .select("url_key, psku, serial_number, mint_cap, athlete, cardset, image_url")
        .in("username", usernames)
        .eq("url_key", sku)
        .order("last_seen_at", { ascending: false })
        .limit(1),
      db
        .from("panini_card_serials")
        .select("edition_external_id, serial_number, mint_cap, owner, serial_state")
        .eq("sku", sku)
        .limit(1),
    ])
    if (held.error) return { ok: false, error: held.error }
    if (serial.error) return { ok: false, error: serial.error }

    const h = ((held.data ?? []) as Record<string, unknown>[])[0] ?? null
    const s = ((serial.data ?? []) as Record<string, unknown>[])[0] ?? null
    if (s && s.serial_state === "BURNT") return { ok: true, card: null }
    const owner = str(s?.owner)?.toLowerCase() ?? null
    const ownedBySerial = owner != null && usernames.includes(owner)
    if (!h && !ownedBySerial) return { ok: true, card: null }

    const editionId = str(s?.edition_external_id) ?? str(h?.psku)
    let e: Record<string, unknown> | null = null
    if (editionId) {
      const ed = await db
        .from("editions")
        .select("player_name, set_name, tier, circulation_count, thumbnail_url")
        .eq("collection_id", PANINI_COLLECTION_ID)
        .eq("external_id", editionId)
        .limit(1)
      if (ed.error) return { ok: false, error: ed.error }
      e = ((ed.data ?? []) as Record<string, unknown>[])[0] ?? null
    }

    return {
      ok: true,
      card: {
        momentId: sku,
        editionId,
        playerName: str(e?.player_name) ?? str(h?.athlete),
        setName: str(e?.set_name) ?? str(h?.cardset),
        serialNumber: num(h?.serial_number) ?? num(s?.serial_number),
        circulationCount: num(h?.mint_cap) ?? num(s?.mint_cap) ?? num(e?.circulation_count),
        tier: str(e?.tier),
        thumbnailUrl: paniniAssetUrl(str(h?.image_url)) ?? paniniAssetUrl(str(e?.thumbnail_url)),
      },
    }
  } catch (error) {
    return { ok: false, error }
  }
}
