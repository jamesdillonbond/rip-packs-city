// app/insights/pack-drops/page.tsx
//
// Public Pack Drops — SERVER component. Discovers + scores the live Vaultopolis
// re-pack drops server-side (the exact payload the
// /api/public/insights/pack-drops route serves) and hands them to the client
// presentation layer as `initialDrops`. This puts the scored RPC-vs-operator
// tables + per-drop drill-down links into the raw server HTML so the unique
// content (RPC pool / pack EV / matched editions) is crawlable — the SEO thesis.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import PackDropsBoardClient from "./PackDropsBoardClient"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchScoredDrops, type ScoredDrop } from "@/lib/pack-drops-board"

// Vaultopolis composition/odds are fixed at publication; 15-min ISR matches the
// route's edge cache.
export const revalidate = 900

async function fetchInitial(): Promise<{ drops: ScoredDrop[]; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString()
  try {
    const drops = await fetchScoredDrops(supabaseAdmin)
    return { drops, fetchedAt }
  } catch (e) {
    console.error("[insights/pack-drops] initial fetch", e instanceof Error ? e.message : e)
    return { drops: [], fetchedAt }
  }
}

export default async function PackDropsPage() {
  const { drops, fetchedAt } = await fetchInitial()
  return <PackDropsBoardClient initialDrops={drops} initialFetchedAt={fetchedAt} />
}
