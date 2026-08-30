import { NextRequest, NextResponse } from "next/server"
import { logTerminalRun } from "@/lib/pipeline/terminal-run"

// Explicit Vercel Function budget (GHA-triggered; some use after() fire-and-forget).
export const maxDuration = 300;

// The pipeline_runs name. Stable and route-owned — NOT the workflow step label.
//
// ⚠ THE COUNTERS ARE ALWAYS NULL HERE, DELIBERATELY. This route is a thin proxy
// to a DEPLOY-ONLY edge function: it measures nothing itself, so any number it
// published would be one nobody took. What it CAN record — and what was missing
// — is that the invocation happened and whether the edge function answered.
const PIPELINE = "backfill-player-names"

const EDGE_FN_URL = "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-player-names"

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    )
  }

  // Verify ingest token
  const auth = req.headers.get("authorization") ?? ""
  const token = auth.replace(/^Bearer\s+/i, "")
  if (!token || token !== ingestToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const res = await fetch(EDGE_FN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + ingestToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(55000),
    })

    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = { raw: text }
    }

    if (!res.ok) {
      console.log("[backfill-player-names] Edge Function returned " + res.status + ": " + text.slice(0, 500))
      await logTerminalRun({
        pipeline: PIPELINE,
        startedAt: startTime,
        ok: false,
        error: `edge function returned ${res.status}`,
        extra: { stage: "edge_fn", status: res.status },
      })
      return NextResponse.json({ error: "Edge Function returned " + res.status, detail: json }, { status: res.status })
    }

    console.log("[backfill-player-names] success:", JSON.stringify(json).slice(0, 500))
    await logTerminalRun({
      pipeline: PIPELINE,
      startedAt: startTime,
      ok: true,
      extra: { stage: "edge_fn", status: res.status },
    })
    return NextResponse.json(json)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log("[backfill-player-names] error:", msg)
    await logTerminalRun({
      pipeline: PIPELINE,
      startedAt: startTime,
      ok: false,
      error: msg,
      extra: { stage: "fetch" },
    })
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
