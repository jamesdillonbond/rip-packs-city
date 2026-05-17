// app/api/cron/snapshot-institutional-wallets/route.ts
//
// Cron entrypoint for the daily institutional-wallet snapshot. Schedule
// on cron-job.org once per day at 06:00 UTC. Bearer
// INGEST_SECRET_TOKEN / CRON_SECRET (also accepts `?token=` query).
//
// Heartbeat-first contract (added 2026-05-17): before doing anything
// else, write to public.cron_heartbeats so the pipeline watchlist can
// distinguish "cron-job.org never fired" from "fired but the edge
// function silently panicked". The actual snapshot + diff work is
// owned by the snapshot-institutional-wallets Supabase edge function
// (EdgeRuntime.waitUntil); this route returns 202 once the edge
// function accepts the invoke.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const INGEST_SECRET_TOKEN = process.env.INGEST_SECRET_TOKEN!
const PIPELINE = "snapshot-institutional-wallets"

async function emitHeartbeat(source: string): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    const { error } = await (supabaseAdmin as any).rpc("upsert_cron_heartbeat", {
      p_pipeline: PIPELINE,
      p_source: source,
    })
    if (error) {
      console.log(`[cron/${PIPELINE}] heartbeat err: ${error.message}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[cron/${PIPELINE}] heartbeat threw: ${msg}`)
  }
}

async function invokeEdgeWithRetry(): Promise<{ status: number; body: unknown; attempts: number; error?: string }> {
  const maxAttempts = 3
  let lastErr: string | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/snapshot-institutional-wallets`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${INGEST_SECRET_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(20_000),
      })
      const text = await res.text()
      let body: unknown = null
      try { body = JSON.parse(text) } catch { body = text.slice(0, 500) }
      if (res.ok) {
        return { status: res.status, body, attempts: attempt + 1 }
      }
      lastErr = `edge ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body).slice(0, 300)}`
      console.log(`[cron/${PIPELINE}] invoke attempt ${attempt + 1} failed: ${lastErr}`)
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      console.log(`[cron/${PIPELINE}] invoke attempt ${attempt + 1} threw: ${lastErr}`)
    }
    if (attempt < maxAttempts - 1) {
      const delay = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  return { status: 502, body: null, attempts: maxAttempts, error: lastErr ?? "unknown" }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? ""
  const queryToken = req.nextUrl.searchParams.get("token")
  const cronSecret = process.env.CRON_SECRET
  const isValid =
    authHeader === `Bearer ${INGEST_SECRET_TOKEN}` ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    queryToken === INGEST_SECRET_TOKEN
  if (!isValid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  await emitHeartbeat("vercel_route")

  const invoke = await invokeEdgeWithRetry()
  if (invoke.error) {
    return NextResponse.json(
      {
        accepted: false,
        edge_status: invoke.status,
        edge_body: invoke.body,
        attempts: invoke.attempts,
        error: invoke.error,
      },
      { status: 502 },
    )
  }
  return NextResponse.json(
    {
      accepted: true,
      edge_status: invoke.status,
      edge_body: invoke.body,
      attempts: invoke.attempts,
    },
    { status: 202 },
  )
}

export async function POST(req: NextRequest) {
  return GET(req)
}
