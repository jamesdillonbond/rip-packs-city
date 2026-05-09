import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// GET /api/admin/cron/detect-league-drift
// Authorization: Bearer <INGEST_SECRET_TOKEN>  OR  ?token=<INGEST_SECRET_TOKEN>
//
// Weekly cron-job.org schedule. Calls public.detect_league_set_drift(), which
// scans Top Shot sets for league mis-categorization (e.g. WNBA-only sets
// landing in the NBA bucket) and inserts new candidates into
// league_set_drift_alerts with status='open'. We fire-and-forget via after()
// so cron-job.org gets an immediate 200; Telegram + pipeline_runs logging
// happens in the background.

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "league-drift-detection"
const SITE_URL = "https://www.rippackscity.com"

type DetectResult = {
  inserted?: number
  skipped_existing_open?: number
  detected_at?: string
}

type DriftAlert = {
  set_name: string | null
  evidence: {
    moment_count?: number | string | null
    distinct_players?: number | string | null
    [k: string]: unknown
  } | null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const queryToken = req.nextUrl.searchParams.get("token")
  const isValid =
    !!TOKEN && (auth === `Bearer ${TOKEN}` || queryToken === TOKEN)
  if (!isValid) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  after(async () => {
    let ok = true
    let errMsg: string | null = null
    let result: DetectResult | null = null

    try {
      const { data, error } = await (supabaseAdmin as any).rpc(
        "detect_league_set_drift"
      )
      if (error) {
        ok = false
        errMsg = error.message ?? String(error)
        console.log(`[${PIPELINE_NAME}] rpc error: ${errMsg}`)
      } else {
        result = (data ?? {}) as DetectResult
        console.log(
          `[${PIPELINE_NAME}] rpc ok result=${JSON.stringify(result)}`
        )
      }
    } catch (e) {
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
      console.log(`[${PIPELINE_NAME}] rpc threw: ${errMsg}`)
    }

    const inserted = Number(result?.inserted ?? 0) || 0
    const skipped = Number(result?.skipped_existing_open ?? 0) || 0
    const detectedAt = result?.detected_at ?? null

    let alerts: DriftAlert[] = []
    if (ok && inserted > 0 && detectedAt) {
      try {
        const { data, error } = await (supabaseAdmin as any)
          .from("league_set_drift_alerts")
          .select("set_name, evidence")
          .eq("status", "open")
          .gte("detected_at", detectedAt)
        if (error) {
          console.log(
            `[${PIPELINE_NAME}] fetch alerts err: ${error.message ?? String(error)}`
          )
        } else {
          alerts = ((data ?? []) as DriftAlert[]).slice().sort((a, b) => {
            const ax = Number(a.evidence?.moment_count ?? 0) || 0
            const bx = Number(b.evidence?.moment_count ?? 0) || 0
            return bx - ax
          })
        }
      } catch (e) {
        console.log(
          `[${PIPELINE_NAME}] fetch alerts threw: ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
    }

    const tgToken = process.env.TELEGRAM_BOT_TOKEN
    const tgChat = process.env.TELEGRAM_CHAT_ID
    if (ok && inserted > 0 && tgToken && tgChat) {
      try {
        const shown = alerts.slice(0, 10)
        const overflow = Math.max(0, alerts.length - shown.length)
        const bullets = shown
          .map((a) => {
            const name = a.set_name ?? "(unnamed set)"
            const moments = Number(a.evidence?.moment_count ?? 0) || 0
            const players = Number(a.evidence?.distinct_players ?? 0) || 0
            return `• "${escapeHtml(name)}" — ${moments} moments, ${players} players, all WNBA roster`
          })
          .join("\n")
        const tail = overflow > 0 ? `\n…and ${overflow} more` : ""
        const text =
          `🏀➡️🏐 <b>League drift detected</b>\n` +
          `${inserted} new candidate(s):\n` +
          `${bullets}${tail}\n\n` +
          `Review: ${SITE_URL}/admin/league-drift`

        const resp = await fetch(
          `https://api.telegram.org/bot${tgToken}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: tgChat,
              text,
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
          }
        )
        if (!resp.ok) {
          const body = await resp.text().catch(() => "")
          console.log(
            `[${PIPELINE_NAME}] telegram non-2xx: ${resp.status} ${body.slice(0, 200)}`
          )
        }
      } catch (e) {
        console.log(
          `[${PIPELINE_NAME}] telegram threw: ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
    }

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: inserted + skipped,
        p_rows_written: inserted,
        p_rows_skipped: skipped,
        p_ok: ok,
        p_error: errMsg,
        p_collection_slug: null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: { inserted, skipped_existing_open: skipped },
      })
    } catch (e) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  })

  return NextResponse.json({ ok: true })
}
