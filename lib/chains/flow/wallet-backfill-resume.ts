// lib/chains/flow/wallet-backfill-resume.ts
//
// #245 (2026-11-10): a wallet-backfill walk continues itself by POSTing to its own route.
// Vercel refuses a deep enough function→function chain with HTTP 508 (INFINITE_LOOP_DETECTED):
// at 6:54 AM PT 11-10 depth 3 of a walk that was itself dispatched by another function got
// 508 on both attempts, and the walk stopped. Retrying the same path cannot succeed.
//
// So a continuation the route could not dispatch is QUEUED here, and a Vercel Cron route
// (/api/cron/wallet-backfill-resume) — a request from OUTSIDE the function chain — dispatches it
// later at the same depth. The walk's own limit (MAX_CONTINUATIONS) still bounds the chain.
//
// ⚠ A duplicate dispatch is harmless: the route answers `skipped_in_progress` for a wallet already
// walking. ⚠ `ok` is derived from what happened: a DB error or a dispatch that failed again makes
// the drain not-ok, and every count means rows actually written/deleted.

import { dispatchContinuation, type ContinuationDispatch } from "@/lib/chains/flow/wallet-backfill-continuation"

export const RESUME_TABLE = "wallet_backfill_resume_queue"
/**
 * Where a resumed continuation is POSTed. NOT the cron request's own origin: Vercel Cron calls the
 * production DEPLOYMENT url (rip-packs-city-<hash>-….vercel.app), which this project's SSO protection
 * covers (`prod_deployment_urls_and_all_previews`), so a POST back to that origin is answered HTTP 401
 * by Vercel before our route runs — every resume 401'd from 1:23 PM PT 11-10 (3 wallets requeued).
 * The canonical domain is unprotected and is where cron-job.org reaches the walk itself.
 */
export const RESUME_DISPATCH_ORIGIN = "https://www.rippackscity.com"
/** a queued row is retried at most this many times by the cron, then dropped (and named in the run log) */
export const MAX_RESUME_ATTEMPTS = 5
/** rows per cron tick — each dispatch waits up to ~17 s (two 8 s attempts) */
export const RESUME_BATCH = 10
/** a row younger than this is left for the walk that queued it to finish winding down */
export const RESUME_MIN_AGE_MS = 60_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export async function enqueueResume(
  db: Db,
  wallet: string,
  depth: number,
  error: string | null,
  nowIso: string = new Date().toISOString(),
): Promise<{ ok: boolean; error: string | null }> {
  const { error: e } = await db
    .from(RESUME_TABLE)
    .upsert({ wallet, depth, queued_at: nowIso, attempts: 0, last_error: error, last_attempt_at: null }, { onConflict: "wallet" })
  return e ? { ok: false, error: e.message } : { ok: true, error: null }
}

export interface ResumeDrainResult {
  ok: boolean
  picked: number
  dispatched: number
  requeued: number
  dropped: Array<{ wallet: string; depth: number; error: string | null }>
  errors: string[]
}

export async function drainResumeQueue(
  db: Db,
  requestUrl: string,
  opts: {
    nowMs?: number
    dispatch?: (url: string, wallet: string, depth: number) => Promise<ContinuationDispatch>
  } = {},
): Promise<ResumeDrainResult> {
  const now = opts.nowMs ?? Date.now()
  const dispatch = opts.dispatch ?? ((url: string, wallet: string, depth: number) => dispatchContinuation(url, wallet, depth))
  const out: ResumeDrainResult = { ok: true, picked: 0, dispatched: 0, requeued: 0, dropped: [], errors: [] }
  const cutoff = new Date(now - RESUME_MIN_AGE_MS).toISOString()
  const read = await db
    .from(RESUME_TABLE)
    .select("wallet, depth, attempts")
    .lt("queued_at", cutoff)
    .order("queued_at", { ascending: true })
    .order("wallet", { ascending: true })
    .limit(RESUME_BATCH)
  if (read.error) {
    return { ...out, ok: false, errors: [`read: ${read.error.message}`] }
  }
  const rows = (read.data ?? []) as Array<{ wallet: string; depth: number; attempts: number | null }>
  out.picked = rows.length
  for (const r of rows) {
    const d = await dispatch(requestUrl, r.wallet, r.depth)
    if (d.ok) {
      const del = await db.from(RESUME_TABLE).delete().eq("wallet", r.wallet)
      if (del.error) out.errors.push(`delete ${r.wallet}: ${del.error.message}`)
      else out.dispatched++
      continue
    }
    const attempts = (r.attempts ?? 0) + 1
    if (attempts >= MAX_RESUME_ATTEMPTS) {
      const del = await db.from(RESUME_TABLE).delete().eq("wallet", r.wallet)
      if (del.error) out.errors.push(`drop ${r.wallet}: ${del.error.message}`)
      else out.dropped.push({ wallet: r.wallet, depth: r.depth, error: d.error })
      continue
    }
    const upd = await db
      .from(RESUME_TABLE)
      .update({ attempts, last_error: d.error, last_attempt_at: new Date(now).toISOString() })
      .eq("wallet", r.wallet)
    if (upd.error) out.errors.push(`requeue ${r.wallet}: ${upd.error.message}`)
    else out.requeued++
  }
  out.ok = out.errors.length === 0 && out.requeued === 0 && out.dropped.length === 0
  return out
}
