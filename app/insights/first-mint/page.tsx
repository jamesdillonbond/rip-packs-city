// app/insights/first-mint/page.tsx
//
// Public First-Mint Trophy Tracker — SERVER component. Fetches the default-view
// cohort stats + multiplier-ranked trophies directly from the public
// topshot_first_mint_trophy_stats + topshot_first_mint_trophies views via
// supabaseAdmin (exactly as /api/public/insights/first-mint does) and hands
// them to the client interactivity layer as `initial`. This puts the ranked
// table AND the per-row /nba-top-shot/edition/<external_id> drill-down links
// into the raw server HTML so the unique trophy content is crawlable. The
// client (FirstMintBoardClient) layers on multiplier/tier/drill-down filters
// as progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import FirstMintBoardClient, { type ApiResponse, type Trophy } from "./FirstMintBoardClient"

// Match the API route's 5-minute edge cache.
export const revalidate = 300

const TROPHY_COLS =
  "edition_id, external_id, player_name, set_name, tier, circulation_count, mint_one_sold_at, mint_one_price_usd, avg_other_serial_price_usd, other_serial_sample_n, multiplier"

async function fetchInitial(): Promise<ApiResponse> {
  const [statsRes, trophiesRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any).from("topshot_first_mint_trophy_stats").select("*").limit(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("topshot_first_mint_trophies")
      .select(TROPHY_COLS)
      .order("multiplier", { ascending: false, nullsFirst: false })
      .limit(100),
  ])
  if (statsRes.error) console.error("[insights/first-mint] stats", statsRes.error.message)
  if (trophiesRes.error) console.error("[insights/first-mint] trophies", trophiesRes.error.message)
  return {
    meta: { fetched_at: new Date().toISOString() },
    stats: statsRes.data?.[0] ?? null,
    trophies: (trophiesRes.data ?? []) as Trophy[],
  }
}

export default async function FirstMintPage() {
  const initial = await fetchInitial()
  return <FirstMintBoardClient initial={initial} />
}
