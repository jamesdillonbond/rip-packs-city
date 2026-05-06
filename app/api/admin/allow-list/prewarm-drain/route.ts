// app/api/admin/allow-list/prewarm-drain/route.ts
//
// Cron-triggered batch drain. Claims up to 5 pending-prewarm rows via the
// allow_list_claim_prewarm RPC (which atomically marks them in_progress and
// bumps prewarm_attempts under SKIP LOCKED), then runs each through the
// shared per-row processor in lib/allow-list/prewarm.ts.
//
// Returns 202 Accepted immediately with the count of rows claimed; the actual
// seeding + Resend + Telegram side effects run in after().
//
// Auth: Authorization: Bearer ${CRON_SECRET}.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { processSinglePrewarmRow, type AllowListRow } from "@/lib/allow-list/prewarm"

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  }
  const authHeader = req.headers.get("authorization") ?? ""
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const { data: claimed, error } = await supabaseAdmin.rpc("allow_list_claim_prewarm", {
    p_limit: 5,
  })
  if (error) {
    console.error("[prewarm-drain] claim RPC error", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (claimed ?? []) as AllowListRow[]
  const origin = new URL(req.url).origin

  if (rows.length === 0) {
    return NextResponse.json(
      { accepted: true, claimed: 0, started_at: new Date().toISOString() },
      { status: 202 }
    )
  }

  after(async () => {
    for (const row of rows) {
      try {
        const outcome = await processSinglePrewarmRow(row, origin)
        console.log(
          `[prewarm-drain] row=${outcome.id} finish=${outcome.finish_status} welcome=${outcome.welcome_sent ? "sent" : "no"}${outcome.ts_error ? ` ts_error=${outcome.ts_error}` : ""}${outcome.welcome_error ? ` welcome_error=${outcome.welcome_error}` : ""}`
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`[prewarm-drain] row=${row.id} threw: ${msg}`)
        // Don't leave the row stuck in_progress — mark it failed so the next
        // claim cycle won't pick it up again until it's reset.
        await supabaseAdmin.rpc("allow_list_finish_prewarm", {
          p_id: row.id,
          p_status: "failed",
          p_summary: null,
          p_error: `unhandled: ${msg}`,
        })
      }
    }
    console.log(`[prewarm-drain] done — processed ${rows.length} row(s)`)
  })

  return NextResponse.json(
    {
      accepted: true,
      claimed: rows.length,
      started_at: new Date().toISOString(),
    },
    { status: 202 }
  )
}
