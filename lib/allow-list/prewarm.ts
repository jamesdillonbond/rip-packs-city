// lib/allow-list/prewarm.ts
//
// Per-row prewarm orchestration shared by:
//   - app/api/admin/allow-list/prewarm-drain  (cron-triggered, batch)
//   - app/api/admin/allow-list/prewarm-now    (admin-triggered, single row)
//
// Responsibilities:
//   1. For each collection the user flagged, run the corresponding seeder
//      (currently only nba_top_shot has a real seeder; others are deferred).
//   2. Build a prewarm_summary jsonb keyed by collection.
//   3. Call allow_list_finish_prewarm with status complete | complete_partial
//      | failed.
//   4. If not failed, render and send the welcome email via Resend, then call
//      allow_list_mark_welcome_sent. On Resend error, also page Trevor on
//      Telegram.
//   5. After 3+ failed prewarm attempts, send a fallback "you're in but data
//      is loading" email and Telegram-alert Trevor.
//
// The function assumes the row has already been claimed (i.e.
// prewarm_status='in_progress'). The drain route claims via the
// allow_list_claim_prewarm RPC; the admin one-shot route stamps the row
// manually before calling in.

import { supabaseAdmin } from "@/lib/supabase"
import {
  buildWelcomeEmailHtml,
  buildWelcomeEmailSubject,
  buildWelcomeEmailText,
  type PrewarmCollectionMeta,
  type PrewarmStatusValue,
  type PrewarmSummary,
} from "@/lib/emails/welcome-email"
import { resolveTopShotUsername } from "@/lib/topshot-username-resolve"

const TS_SEEDER_TIMEOUT_MS = 90_000

const ALL_COLLECTIONS = [
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "disney_pinnacle",
  "ufc_strike",
] as const

type CollectionKey = (typeof ALL_COLLECTIONS)[number]

const FROM_ADDRESS = "Rip Packs City <noreply@rippackscity.com>"

export interface AllowListRow {
  id: string
  email: string
  wallet_addr: string | null
  username: string | null
  collections: string[] | null
  prewarm_attempts: number | null
}

export interface ProcessOutcome {
  id: string
  email: string
  finish_status: "complete" | "complete_partial" | "failed"
  prewarm_summary: PrewarmSummary
  ts_error: string | null
  welcome_sent: boolean
  welcome_error: string | null
  attempts: number
}

interface SeedResult {
  status: PrewarmStatusValue
  error?: string | null
  found?: number
}

async function runTopShotSeeder(
  origin: string,
  walletAddr: string
): Promise<SeedResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TS_SEEDER_TIMEOUT_MS)
  try {
    const res = await fetch(`${origin}/api/wallet-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: walletAddr, collection: "nba-top-shot" }),
      signal: controller.signal,
    })
    if (!res.ok) {
      return {
        status: "failed",
        error: `wallet-search HTTP ${res.status}`,
      }
    }
    // wallet-search response shape: { summary: { totalMoments: number, ... }, ... }
    // Read totalMoments so the orchestrator can record a real count in
    // prewarm_summary._meta and the reconciler can distinguish a truly empty
    // wallet from a silent scan failure.
    let found = 0
    try {
      const body = (await res.json().catch(() => null)) as {
        summary?: { totalMoments?: number }
      } | null
      const tm = body?.summary?.totalMoments
      if (typeof tm === "number" && Number.isFinite(tm)) found = tm
    } catch {
      // body parse failure is non-fatal — leave found=0 and let the meta line
      // record scanned=true,found=0 so monitoring can flag the divergence.
    }
    return { status: "complete", found }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if ((err as { name?: string })?.name === "AbortError") {
      return { status: "failed", error: `wallet-search timed out after ${TS_SEEDER_TIMEOUT_MS}ms` }
    }
    return { status: "failed", error: `wallet-search threw: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

// Early-access form lets users sign up with email + username only (no wallet
// address). Without a wallet, the seeder branch below would short-circuit
// every flagged collection to "deferred" and the user would land on an empty
// dashboard. Resolve the username to a Flow address up front so the rest of
// processSinglePrewarmRow has something to seed against. The same Top Shot
// username + Dapper SSO link governs all 4 marketplaces, so a single
// resolution covers every flagged collection.
async function resolveUsernameToWallet(
  row: AllowListRow,
  summary: PrewarmSummary
): Promise<void> {
  if (row.wallet_addr) return
  if (!row.username || !row.username.trim()) return

  let resolved
  try {
    resolved = await resolveTopShotUsername(row.username)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    summary.username_resolution_failure = `gql_error: ${msg.slice(0, 200)}`
    return
  }
  if (!resolved) {
    summary.username_resolution_failure = `not_found:${row.username}`
    return
  }

  const { error: updateErr } = await supabaseAdmin
    .from("allow_list")
    .update({ wallet_addr: resolved.walletAddress })
    .eq("id", row.id)
  if (updateErr) {
    summary.username_resolution_failure = `update_error: ${updateErr.message.slice(0, 200)}`
    return
  }
  row.wallet_addr = resolved.walletAddress
}

function flaggedSet(row: AllowListRow): Set<CollectionKey> {
  const out = new Set<CollectionKey>()
  for (const raw of row.collections ?? []) {
    if ((ALL_COLLECTIONS as readonly string[]).includes(raw)) {
      out.add(raw as CollectionKey)
    }
  }
  return out
}

async function sendTelegramAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.log("[prewarm] telegram env missing — skip alert")
    return
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[prewarm] telegram alert throw: ${msg}`)
  }
}

interface SendEmailArgs {
  to: string
  subject: string
  html: string
  text: string
}

async function sendViaResend(args: SendEmailArgs): Promise<{ ok: true } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY is not set" }
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Resend threw: ${msg}` }
  }
}

async function sendWelcomeEmail(
  row: AllowListRow,
  prewarmSummary: PrewarmSummary
): Promise<{ ok: true } | { ok: false; error: string }> {
  const opts = {
    email: row.email,
    wallet_addr: row.wallet_addr,
    username: row.username,
    collections: row.collections,
    prewarm_summary: prewarmSummary,
  }
  return sendViaResend({
    to: row.email,
    subject: buildWelcomeEmailSubject(opts),
    html: buildWelcomeEmailHtml(opts),
    text: buildWelcomeEmailText(opts),
  })
}

async function sendFallbackLoadingEmail(
  row: AllowListRow,
  prewarmSummary: PrewarmSummary
): Promise<{ ok: true } | { ok: false; error: string }> {
  const opts = {
    email: row.email,
    wallet_addr: row.wallet_addr,
    username: row.username,
    collections: row.collections,
    prewarm_summary: prewarmSummary,
  }
  // Same HTML template — the badges already convey the in-progress state.
  // Subject is tweaked so Trevor can spot the fallback path in his outbox.
  const subject = "You're in at Rip Packs City — your data is still loading"
  return sendViaResend({
    to: row.email,
    subject,
    html: buildWelcomeEmailHtml(opts),
    text: buildWelcomeEmailText(opts),
  })
}

export async function processSinglePrewarmRow(
  row: AllowListRow,
  origin: string
): Promise<ProcessOutcome> {
  const flagged = flaggedSet(row)
  const summary: PrewarmSummary = {}
  const meta: Record<string, PrewarmCollectionMeta> = {}
  let tsError: string | null = null

  await resolveUsernameToWallet(row, summary)

  // nba_top_shot — only collection with a real seeder today.
  if (flagged.has("nba_top_shot")) {
    if (!row.wallet_addr) {
      summary.nba_top_shot = "deferred"
      meta.nba_top_shot = { scanned: false, found: 0 }
    } else {
      const r = await runTopShotSeeder(origin, row.wallet_addr)
      summary.nba_top_shot = r.status
      meta.nba_top_shot = {
        scanned: r.status === "complete",
        found: typeof r.found === "number" ? r.found : 0,
      }
      if (r.status === "failed") tsError = r.error ?? "unknown seeder failure"
    }
  }

  // Other collections flagged on the form: seeders not yet shipped → deferred.
  for (const key of ["nfl_all_day", "disney_pinnacle", "laliga_golazos", "ufc_strike"] as CollectionKey[]) {
    if (flagged.has(key)) {
      summary[key] = "deferred"
      meta[key] = { scanned: false, found: 0 }
    }
  }

  // Stash structured per-collection telemetry in a sibling key. The welcome
  // email renderer only iterates known collection labels, so `_meta` won't
  // surface to the user — it exists for the reconciler / monitoring to spot
  // silent failures (status='complete' but found=0 across the board).
  if (Object.keys(meta).length > 0) summary._meta = meta

  // Determine finish status.
  // - failed if the TS seeder errored out
  // - complete if every flagged collection completed
  // - complete_partial if anything was deferred (or nothing was flagged at all)
  const flaggedKeys = Array.from(flagged)
  const allComplete =
    flaggedKeys.length > 0 &&
    flaggedKeys.every((k) => summary[k] === "complete")
  const anyFailed = flaggedKeys.some((k) => summary[k] === "failed")

  let finishStatus: "complete" | "complete_partial" | "failed"
  if (anyFailed) {
    finishStatus = "failed"
  } else if (allComplete) {
    finishStatus = "complete"
  } else {
    finishStatus = "complete_partial"
  }

  const { error: finishErr } = await supabaseAdmin.rpc("allow_list_finish_prewarm", {
    p_id: row.id,
    p_status: finishStatus,
    p_summary: summary as unknown as Record<string, unknown>,
    p_error: tsError,
  })
  if (finishErr) {
    console.log(
      `[prewarm] finish_prewarm RPC failed for row=${row.id}: ${finishErr.message}`
    )
  }

  const attempts = (row.prewarm_attempts ?? 0) + 1

  // ── Welcome email branch ─────────────────────────────────────────────
  let welcomeSent = false
  let welcomeError: string | null = null

  if (finishStatus !== "failed") {
    const send = await sendWelcomeEmail(row, summary)
    if (send.ok) {
      welcomeSent = true
      const { error: markErr } = await supabaseAdmin.rpc("allow_list_mark_welcome_sent", {
        p_id: row.id,
        p_error: null,
      })
      if (markErr) {
        console.log(
          `[prewarm] mark_welcome_sent failed for row=${row.id}: ${markErr.message}`
        )
      }
    } else {
      welcomeError = send.error
      await supabaseAdmin.rpc("allow_list_mark_welcome_sent", {
        p_id: row.id,
        p_error: send.error,
      })
      await sendTelegramAlert(
        [
          "⚠️ RPC welcome email FAILED",
          `Row: ${row.id}`,
          `Email: ${row.email}`,
          `Error: ${send.error}`,
        ].join("\n")
      )
    }
  } else if (attempts >= 3) {
    // Failed three times in a row — switch to a "you're in, data still loading"
    // fallback email so the user isn't left in limbo, and page Trevor.
    const send = await sendFallbackLoadingEmail(row, summary)
    if (send.ok) {
      welcomeSent = true
      await supabaseAdmin.rpc("allow_list_mark_welcome_sent", {
        p_id: row.id,
        p_error: null,
      })
    } else {
      welcomeError = send.error
      await supabaseAdmin.rpc("allow_list_mark_welcome_sent", {
        p_id: row.id,
        p_error: send.error,
      })
    }
    await sendTelegramAlert(
      [
        "🚨 RPC prewarm failing repeatedly",
        `Row: ${row.id}`,
        `Email: ${row.email}`,
        `Wallet: ${row.wallet_addr ?? "(none)"}`,
        `Attempts: ${attempts}`,
        `Last error: ${tsError ?? "(unknown)"}`,
        `Sent fallback email: ${send.ok ? "yes" : "no"}`,
      ].join("\n")
    )
  }

  return {
    id: row.id,
    email: row.email,
    finish_status: finishStatus,
    prewarm_summary: summary,
    ts_error: tsError,
    welcome_sent: welcomeSent,
    welcome_error: welcomeError,
    attempts,
  }
}
