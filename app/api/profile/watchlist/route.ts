import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

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

  try {
    const { data: items, error } = await supabase
      .from("watchlist_items")
      .select("*")
      .eq("owner_key", ownerKey)
      .order("created_at", { ascending: false })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const rows = (items ?? []) as WatchlistRow[]

    const editionIds = rows
      .map((r) => r.edition_id)
      .filter((id): id is string => typeof id === "string")

    const editionMap = new Map<
      string,
      { player_name: string | null; set_name: string | null; tier: string | null }
    >()
    if (editionIds.length > 0) {
      const { data: eds } = await supabase
        .from("editions")
        .select("id, player_name, set_name, tier")
        .in("id", editionIds)
      for (const e of eds ?? []) {
        if (e.id) {
          editionMap.set(e.id, {
            player_name: e.player_name ?? null,
            set_name: e.set_name ?? null,
            tier: (e.tier as string | null) ?? null,
          })
        }
      }
    }

    // Latest FMV + floor per edition (single query, take DISTINCT ON latest snapshot).
    const fmvMap = new Map<string, number>()
    const floorMap = new Map<string, number>()
    if (editionIds.length > 0) {
      const { data: snaps } = await supabase
        .from("fmv_snapshots")
        .select("edition_id, fmv_usd, floor_price_usd, computed_at")
        .in("edition_id", editionIds)
        .order("computed_at", { ascending: false })
      for (const s of snaps ?? []) {
        const eid = s.edition_id as string | null
        if (!eid) continue
        if (!fmvMap.has(eid) && typeof s.fmv_usd === "number") {
          fmvMap.set(eid, s.fmv_usd)
        }
        if (!floorMap.has(eid) && typeof s.floor_price_usd === "number") {
          floorMap.set(eid, s.floor_price_usd)
        }
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
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
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
    const { error } = await supabase
      .from("watchlist_items")
      .delete()
      .eq("id", itemId)
      .eq("owner_key", ownerKey)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error("[watchlist DELETE]", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
