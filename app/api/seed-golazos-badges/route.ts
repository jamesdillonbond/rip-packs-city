import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { classifyGolazos, GOLAZOS_BADGE_RULES } from "@/lib/golazos-badges"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function priorityOf(title: string) {
  const r = GOLAZOS_BADGE_RULES.find(r => r.badgeTitle === title)
  return r?.priority ?? 0
}

export async function GET() {
  const { count, error } = await (supabase as any)
    .from("badge_editions")
    .select("*", { count: "exact", head: true })
    .eq("collection_id", GOLAZOS_COLLECTION_ID)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ collection_id: GOLAZOS_COLLECTION_ID, count: count ?? 0 })
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const PAGE_SIZE = 1000
  const editions: any[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: page, error } = await (supabase as any)
      .from("editions")
      .select("id, external_id, name, set_name, player_name, tier")
      .eq("collection_id", GOLAZOS_COLLECTION_ID)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const pageRows = page ?? []
    editions.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) break
  }

  const rows: any[] = []
  let withBadges = 0
  const scanned = editions.length

  for (const e of editions) {
    const setText = e.set_name ?? e.name ?? ""
    const matched = classifyGolazos(setText)
    if (!matched.length) continue
    withBadges++

    const badgeScore = matched.reduce((sum, title) => sum + priorityOf(title), 0)
    const setPlayTags = matched.map(title => ({ id: slug(title), title }))

    rows.push({
      id: e.external_id,
      external_id: e.external_id,
      collection_id: GOLAZOS_COLLECTION_ID,
      set_name: setText,
      player_name: e.player_name ?? null,
      tier: e.tier ?? null,
      series_number: 1,
      badge_score: badgeScore,
      play_tags: [],
      set_play_tags: setPlayTags,
      is_three_star_rookie: false,
      has_rookie_mint: false,
      parallel_id: 0,
      parallel_name: "Standard",
      circulation_count: 0,
      effective_supply: 0,
      burned: 0,
      locked: 0,
      owned: 0,
      hidden_in_packs: 0,
      burn_rate_pct: 0,
      lock_rate_pct: 0,
      flow_retired: false,
      asset_path_prefix: null,
    })
  }

  let inserted = 0
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error: upErr } = await (supabase as any)
      .from("badge_editions")
      .upsert(chunk, { onConflict: "id" })
    if (upErr) {
      console.error("[seed-golazos-badges] upsert error:", upErr.message)
    } else {
      inserted += chunk.length
    }
  }

  return NextResponse.json({ scanned, withBadges, inserted })
}
