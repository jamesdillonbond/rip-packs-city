import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireOwnedKey } from "@/lib/auth/owner-key-guard"
import { awardPoints } from "@/lib/rewards"
import { selectInChunks } from "@/lib/supabase/chunked-in"

type WatchlistRow = {
  id: string
  owner_key: string
  edition_id: string | null
  collection_id: string | null
  target_price: number | string | null
  notes: string | null
  created_at: string
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey")
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 })
  }

  // SECURITY: a watchlist is PRIVATE, and this is a service-role read whose row
  // selector (`owner_key`) came from the request param rather than the session —
  // so any caller could enumerate another user's watchlist by supplying their
  // (public) username. The read target must be proven to belong to the caller.
  const gate = await requireOwnedKey(ownerKey)
  if (gate instanceof Response) return gate

  try {
    const { data: items, error } = await supabase
      .from("watchlist_items")
      .select("*")
      .eq("owner_key", ownerKey)
      .order("created_at", { ascending: false })
    if (error) {
      return apiErrorResponse(error, "api/profile/watchlist");
    }
    const rows = (items ?? []) as WatchlistRow[]

    const editionIds = rows
      .map((r) => r.edition_id)
      .filter((id): id is string => typeof id === "string")

    // A watchlist has NO size cap, so every `.in()` below is chunked — an
    // unchunked `.in()` past 1000 matches silently drops the overflow (missing
    // player/set/tier, and — worse — missing FMV/floor, which makes below_target
    // read false so alerts stop firing).
    const editionMap = new Map<
      string,
      { player_name: string | null; set_name: string | null; tier: string | null }
    >()
    const eds = await selectInChunks(
      supabase, "editions", "id, player_name, set_name, tier", "id", editionIds
    )
    for (const e of eds) {
      if (e.id) {
        editionMap.set(e.id, {
          player_name: e.player_name ?? null,
          set_name: e.set_name ?? null,
          tier: (e.tier as string | null) ?? null,
        })
      }
    }

    // Latest FMV + floor per edition from fmv_current (DISTINCT ON (edition_id)
    // latest), NOT raw fmv_snapshots — the DESC-history read would blow the
    // 1000-row clamp and drop overflow editions' FMV/floor. fmv_current returns
    // one row per edition, so no ordering is needed here.
    const fmvMap = new Map<string, number>()
    const floorMap = new Map<string, number>()
    const snaps = await selectInChunks(
      supabase, "fmv_current", "edition_id, fmv_usd, floor_price_usd", "edition_id", editionIds
    )
    for (const s of snaps) {
      const eid = s.edition_id as string | null
      if (!eid) continue
      if (!fmvMap.has(eid) && typeof s.fmv_usd === "number") {
        fmvMap.set(eid, s.fmv_usd)
      }
      if (!floorMap.has(eid) && typeof s.floor_price_usd === "number") {
        floorMap.set(eid, s.floor_price_usd)
      }
    }

    const resp = rows.map((r) => {
      const ed = r.edition_id ? editionMap.get(r.edition_id) : null
      const fmv = r.edition_id ? fmvMap.get(r.edition_id) ?? null : null
      const ask = r.edition_id ? floorMap.get(r.edition_id) ?? null : null
      const target = r.target_price !== null ? Number(r.target_price) : null
      const belowTarget =
        target !== null && ask !== null ? ask <= target : false
      return {
        id: r.id,
        edition_id: r.edition_id,
        player_name: ed?.player_name ?? null,
        set_name: ed?.set_name ?? null,
        tier: ed?.tier ?? null,
        target_price: target,
        current_fmv: fmv,
        current_ask: ask,
        below_target: belowTarget,
        notes: r.notes,
        created_at: r.created_at,
      }
    })

    return NextResponse.json({ items: resp })
  } catch (err: any) {
    console.error("[watchlist GET]", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { ownerKey, editionId, collectionId, targetPrice, notes } = body ?? {}
    if (!ownerKey || !editionId) {
      return NextResponse.json(
        { error: "ownerKey and editionId required" },
        { status: 400 }
      )
    }

    // SECURITY: service-role write whose `owner_key` came from the request body
    // rather than the session — any signed-in (or, before this, any anonymous)
    // caller could insert rows into another user's watchlist.
    const gate = await requireOwnedKey(ownerKey)
    if (gate instanceof Response) return gate

    const { data, error } = await supabase
      .from("watchlist_items")
      .upsert(
        {
          owner_key: ownerKey,
          edition_id: editionId,
          collection_id: collectionId ?? null,
          target_price: targetPrice ?? null,
          notes: notes ?? null,
        },
        { onConflict: "owner_key,edition_id" }
      )
      .select()
      .single()
    if (error) {
      return apiErrorResponse(error, "api/profile/watchlist");
    }

    // Rewards: a logged-in user tracking a Moment earns add_watchlist_item
    // (daily_cap 5). Best-effort — never block the save. gate.user is the
    // authenticated caller the ownership guard already proved owns this key.
    try {
      await awardPoints(gate.user.id, "add_watchlist_item")
    } catch { /* rewards must never break the watchlist write */ }

    return NextResponse.json({ item: data })
  } catch (err: any) {
    console.error("[watchlist POST]", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const ownerKey =
      body?.ownerKey ?? req.nextUrl.searchParams.get("ownerKey")
    const itemId = body?.itemId ?? req.nextUrl.searchParams.get("itemId")
    if (!ownerKey || !itemId) {
      return NextResponse.json(
        { error: "ownerKey and itemId required" },
        { status: 400 }
      )
    }

    // SECURITY: service-role delete scoped by an `owner_key` that came from the
    // request rather than the session — any caller could delete rows out of
    // another user's watchlist.
    const gate = await requireOwnedKey(ownerKey)
    if (gate instanceof Response) return gate

    const { error } = await supabase
      .from("watchlist_items")
      .delete()
      .eq("id", itemId)
      .eq("owner_key", ownerKey)
    if (error) {
      return apiErrorResponse(error, "api/profile/watchlist");
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error("[watchlist DELETE]", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
