// app/api/insider-signals/route.ts
//
// Returns non-expired topshot_insider_alerts. Two modes:
//   • GET ?collection=<kebab>&limit=N — collection-scoped via SECDEF
//     get_insider_signals_top_n RPC. Used by /[collection]/overview's
//     InsiderSignalsPanel.
//   • GET (no params) — legacy ungated read of the alert pool for the
//     dashboard surface (components/InsiderSignals.tsx). Limited to 50,
//     order: severity DESC, generated_at DESC, expires_at gate.
//
// Auth: the COLLECTION-SCOPED mode is public (it backs the anon-reachable
// /[collection]/overview InsiderSignalsPanel — collection-level market
// intelligence via the SECDEF RPC, no user data; proxy.ts allow-lists the GET).
// The legacy no-param pool read stays session-gated.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

// Kebab-case (URL) → underscored DB slug (collections.slug). UFC's DB slug is
// `ufc_strike`, not `ufc`, because the detectors run against that exact value
// (see app/api/cron/run-insider-detectors/route.ts COLLECTIONS).
const KEBAB_TO_DB_SLUG: Record<string, string> = {
  "nba-top-shot": "nba_top_shot",
  "nfl-all-day": "nfl_all_day",
  "laliga-golazos": "laliga_golazos",
  "disney-pinnacle": "disney_pinnacle",
  "ufc": "ufc_strike",
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const collection = url.searchParams.get("collection")
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "8", 10)
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 8, 50))

  if (collection) {
    // Public, collection-scoped market intelligence — no session required.
    const dbSlug = KEBAB_TO_DB_SLUG[collection] ?? collection
    const { data, error } = await (supabaseAdmin as any).rpc(
      "get_insider_signals_top_n",
      { p_collection_slug: dbSlug, p_limit: limit }
    )
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, alerts: data ?? [], collection: dbSlug })
  }

  // Legacy no-param pool read — preserved for components/InsiderSignals.tsx
  // callers; stays session-gated (not anon-reachable surface).
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }
  const nowIso = new Date().toISOString()
  const { data, error } = await (supabaseAdmin as any)
    .from("topshot_insider_alerts")
    .select("id, alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("severity", { ascending: false })
    .order("generated_at", { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, alerts: data ?? [] })
}
