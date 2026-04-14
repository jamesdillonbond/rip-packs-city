import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

interface AchievementDef {
  id: string
  name: string
  description: string
  icon: string
  category: string
}

interface UserAchievementRow {
  achievement_id: string
  unlocked_at: string
}

const LEGENDARY_TIERS = new Set(["LEGENDARY", "ULTIMATE", "Legendary", "Ultimate"])
const ULTIMATE_TIERS = new Set(["ULTIMATE", "Ultimate"])

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey")
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 })
  }

  try {
    const [defsRes, userRes, walletsRes] = await Promise.all([
      supabase.from("achievement_definitions").select("*"),
      supabase
        .from("user_achievements")
        .select("achievement_id, unlocked_at")
        .eq("owner_key", ownerKey),
      supabase.from("saved_wallets").select("*").eq("owner_key", ownerKey),
    ])

    const defs: AchievementDef[] = (defsRes.data ?? []) as any
    const existing = new Map<string, string>()
    for (const r of (userRes.data ?? []) as UserAchievementRow[]) {
      existing.set(r.achievement_id, r.unlocked_at)
    }
    const wallets: any[] = walletsRes.data ?? []
    const addrs: string[] = wallets
      .map((w) => w.wallet_address)
      .filter((a: any): a is string => typeof a === "string" && a.length > 0)

    // Aggregate stats from saved_wallets cache
    let totalMoments = 0
    let totalFmv = 0
    let anyLegendary = false
    let anyUltimate = false
    let totalBadges = 0
    for (const w of wallets) {
      totalMoments += Number(w.cached_moment_count ?? 0) || 0
      totalFmv += Number(w.cached_fmv ?? w.cached_fmv_usd ?? 0) || 0
      const top = (w.cached_top_tier ?? "") as string
      if (LEGENDARY_TIERS.has(top)) anyLegendary = true
      if (ULTIMATE_TIERS.has(top)) anyUltimate = true
      const badges = w.cached_badges
      if (Array.isArray(badges)) totalBadges += badges.length
    }

    // pack_ripper
    let packCount = 0
    if (addrs.length > 0) {
      const { count } = await supabase
        .from("moment_acquisitions")
        .select("id", { count: "exact", head: true })
        .in("wallet", addrs)
        .eq("acquisition_method", "pack_pull")
      packCount = count ?? 0
    }

    // multi_collection
    let collectionCount = 0
    if (addrs.length > 0) {
      const { data } = await supabase
        .from("wallet_moments_cache")
        .select("collection_id")
        .in("wallet_address", addrs)
      const set = new Set<string>()
      for (const r of data ?? []) {
        if (r.collection_id) set.add(r.collection_id as string)
      }
      collectionCount = set.size
    }

    const earnedIds = new Set<string>()
    if (totalMoments >= 100) earnedIds.add("century_club")
    if (totalMoments >= 500) earnedIds.add("five_hundred_club")
    if (anyLegendary) earnedIds.add("legendary_holder")
    if (anyUltimate) earnedIds.add("ultimate_collector")
    if (packCount >= 50) earnedIds.add("pack_ripper")
    if (collectionCount >= 2) earnedIds.add("multi_collection")
    if (totalBadges >= 10) earnedIds.add("badge_hunter")
    if (totalFmv >= 10000) earnedIds.add("whale_alert")
    // set_completionist, diamond_hands: intentionally skipped (not computed here)

    const newlyEarned: { owner_key: string; achievement_id: string }[] = []
    for (const id of earnedIds) {
      if (!existing.has(id)) {
        newlyEarned.push({ owner_key: ownerKey, achievement_id: id })
      }
    }
    if (newlyEarned.length > 0) {
      const { error } = await supabase
        .from("user_achievements")
        .upsert(newlyEarned, { onConflict: "owner_key,achievement_id" })
        .select("achievement_id, unlocked_at")
      if (!error) {
        const nowIso = new Date().toISOString()
        for (const n of newlyEarned) {
          if (!existing.has(n.achievement_id)) existing.set(n.achievement_id, nowIso)
        }
      }
    }

    const achievements = defs.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      icon: d.icon,
      category: d.category,
      earned: earnedIds.has(d.id),
      unlocked_at: existing.get(d.id) ?? null,
    }))

    return NextResponse.json({ achievements })
  } catch (err: any) {
    console.error("[achievements GET]", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
