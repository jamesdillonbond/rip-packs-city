// GET /api/analytics/insider/signals
//
// Composes three Supabase tables into one dashboard payload:
//   topshot_insider_alerts       — heuristic alert feed (unexpired)
//   topshot_insider_buybacks     — confirmed Top-Shot-team buyback sales
//   external_announcements       — Dapper / Twitter / news posts
//
// has_data = (alerts + buybacks + announcements > 0). Frontend uses that as
// the visibility gate — InsiderSignals renders nothing when empty.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import type {
  InsiderAlertRow,
  InsiderBuybackRow,
  ExternalAnnouncementRow,
  InsiderSignalsResponse,
} from "@/lib/analytics-types"

export const revalidate = 60

export async function GET() {
  const t0 = Date.now()
  try {
    const nowIso = new Date().toISOString()

    const [alertsRes, buybacksRes, announcementsRes] = await Promise.all([
      (supabaseAdmin as any)
        .from("topshot_insider_alerts")
        .select("id, alert_type, title, summary, severity, generated_at, expires_at")
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
        .order("generated_at", { ascending: false })
        .limit(5),
      (supabaseAdmin as any)
        .from("topshot_insider_buybacks")
        .select(
          "id, acquisition_method, buyer_address, seller_address, moment_id, serial_number, price_usd, sold_at, editions:edition_id(player_name, set_name)"
        )
        .order("sold_at", { ascending: false })
        .limit(5),
      (supabaseAdmin as any)
        .from("external_announcements")
        .select("id, source, source_channel, source_url, title, posted_at")
        .order("posted_at", { ascending: false })
        .limit(5),
    ])

    if (alertsRes.error) console.log("[analytics/insider] alerts_error", alertsRes.error.message)
    if (buybacksRes.error) console.log("[analytics/insider] buybacks_error", buybacksRes.error.message)
    if (announcementsRes.error) console.log("[analytics/insider] announcements_error", announcementsRes.error.message)

    const alerts: InsiderAlertRow[] = (alertsRes.data ?? []) as InsiderAlertRow[]
    const buybacks: InsiderBuybackRow[] = ((buybacksRes.data ?? []) as any[]).map((r) => {
      const edition = Array.isArray(r.editions) ? r.editions[0] : r.editions
      return {
        id: r.id,
        acquisition_method: r.acquisition_method ?? null,
        buyer_address: r.buyer_address ?? null,
        seller_address: r.seller_address ?? null,
        moment_id: r.moment_id ?? null,
        serial_number: r.serial_number ?? null,
        price_usd: r.price_usd != null ? Number(r.price_usd) : null,
        sold_at: r.sold_at,
        player_name: edition?.player_name ?? null,
        set_name: edition?.set_name ?? null,
      }
    })
    const announcements: ExternalAnnouncementRow[] = (announcementsRes.data ?? []) as ExternalAnnouncementRow[]

    const payload: InsiderSignalsResponse = {
      has_data: alerts.length + buybacks.length + announcements.length > 0,
      alerts,
      buybacks,
      announcements,
      generated_at: nowIso,
    }

    console.log(
      `[analytics/insider] ok elapsed=${Date.now() - t0}ms alerts=${alerts.length} buybacks=${buybacks.length} announcements=${announcements.length}`
    )

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
      },
    })
  } catch (e: any) {
    console.log("[analytics/insider] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "insider_signals_failed" }, { status: 500 })
  }
}
