// app/api/cron/wallet-backfill-resume/route.ts
//
// #245 (2026-11-10): Vercel Cron (vercel.json, every 10 min). Dispatches wallet-backfill
// continuations the walk could not dispatch itself — Vercel answered its self-POST with HTTP 508
// (a function→function chain too deep). A cron request starts OUTSIDE that chain, so its dispatch
// is a fresh one. Logic and its contract: lib/chains/flow/wallet-backfill-resume.ts.
//
// An empty queue is a clean run (ok, picked 0). `ok` is false when any dispatch failed again, a
// row was dropped after MAX_RESUME_ATTEMPTS, or a queue write failed — each is named in `extra`.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { drainResumeQueue } from "@/lib/chains/flow/wallet-backfill-resume"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "wallet-backfill-resume"

function authorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (!!cronSecret && bearerMatches(auth, "CRON_SECRET")) || (!!ingest && bearerMatches(auth, "INGEST_SECRET_TOKEN"))
}

async function run(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const invokedAt = Date.now()
  const url = request.url
  after(async () => {
    // Heartbeat BEFORE the work: a maxDuration kill is otherwise invisible.
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: invokedAt }, supabaseAdmin)
    const started = Date.now()
    let ok = false
    const extra: Record<string, unknown> = {}
    try {
      const r = await drainResumeQueue(supabaseAdmin, url)
      ok = r.ok
      extra.picked = r.picked
      extra.dispatched = r.dispatched
      extra.requeued = r.requeued
      if (r.dropped.length) extra.dropped = r.dropped
      if (r.errors.length) extra.errors = r.errors.slice(0, 10)
    } catch (e) {
      ok = false
      extra.error = e instanceof Error ? e.message : String(e)
    }
    extra.elapsed_ms = Date.now() - started
    try {
      const { error } = await supabaseAdmin.rpc("log_pipeline_run", { p_pipeline: PIPELINE_NAME, p_ok: ok, p_extra: extra })
      if (error) console.warn(`[${PIPELINE_NAME}] run row not written: ${error.message}`)
    } catch (e) {
      console.warn(`[${PIPELINE_NAME}] run row threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  return NextResponse.json({ status: "accepted" }, { status: 202 })
}

export async function GET(request: NextRequest) {
  return run(request)
}

export async function POST(request: NextRequest) {
  return run(request)
}
