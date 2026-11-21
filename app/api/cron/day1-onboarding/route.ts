// app/api/cron/day1-onboarding/route.ts
//
// The day-1 onboarding email (2026-11-16, Trevor: "Figure out the day 1 email and
// additional funnel building"). Once per account, 20–72 h after sign-up, to a
// member who has NOT come back on a second day:
//   no_wallet — "add your Top Shot username" (3 of 24 signups, 30 days to 11-16);
//   wallet    — their collection's dashboard value (6 of 21 who saved a wallet
//               never returned).
// The weekly portfolio email (weekly-digest) needs 7+ days of history, so without
// this a new member hears nothing in their first week.
//
// Selector: get_day1_onboarding_candidates (SECURITY DEFINER, service_role only;
// migration 20261116143326). Copy: lib/emails/day1-onboarding-email.ts.
//
// DISABLED BY DEFAULT. It sends nothing unless DAY1_ONBOARDING_ENABLED === "1" AND
// the CAN-SPAM postal address (RPC_SENDER_POSTAL_ADDRESS) is set — the same gate
// as the weekly digests (commercialSendBlockedReason).
//
// Safety (mirrors signup-reminder / weekly-digest):
//   * ?dry=1 previews the exact recipient list after unsubscribe + dedup and SENDS
//     NOTHING, ignoring the flag. The preview never returns an email address — it
//     reports username, segment and value only.
//   * Every send carries a working unsubscribe link (email_subscribers token);
//     anyone with unsubscribed_at set is skipped.
//   * Once per ACCOUNT, ever: alert_deliveries keyed (owner_key = user id,
//     alert_kind/subject_key day1_onboarding, bucket "day1"). The row is CLAIMED
//     before the send (claimEmailDelivery) and marked sent after; a failed send
//     releases the claim so a later run retries. A guard read that cannot be
//     confirmed skips the recipient (fail closed).
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}. Method: GET or POST.

import { bearerMatches } from "@/lib/auth/bearer-secret"
import { commercialSendBlockedReason, REPLY_TO } from "@/lib/emails/sender-identity"
import { NextRequest, NextResponse, after } from "next/server"
import { alreadySentEmail, claimEmailDelivery, ensureUnsubToken } from "@/lib/email/recipient-guards"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { buildDay1Html, buildDay1Subject, buildDay1Text, type Day1Segment } from "@/lib/emails/day1-onboarding-email"
import { num, toRecipient, type Day1Candidate } from "@/lib/emails/day1-onboarding-recipients"
import { loadAlertSuggestion } from "@/lib/emails/alert-suggestion"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE_NAME = "day1-onboarding"
const FROM = "Rip Packs City <rpc-alerts@rippackscity.com>"
const ALERT_KIND = "day1_onboarding"
const SUBJECT_KEY = "day1_onboarding"
const BUCKET = "day1"
const ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const DEFAULT_MIN_HOURS = 20
const DEFAULT_MAX_HOURS = 72
const MAX_RECIPIENTS = 200
// Same bound as signup-reminder / alerts-send for this upstream (p95 ~1.6 s).
const SEND_TIMEOUT_MS = 10_000

function authed(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN", "CRON_SECRET")
}

function clampInt(v: string | null, dflt: number, lo: number, hi: number): number {
  const n = Number(v ?? dflt)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

async function loadCandidates(minHours: number, maxHours: number): Promise<Day1Candidate[]> {
  const { data, error } = await (supabaseAdmin as any).rpc("get_day1_onboarding_candidates", {
    p_min_hours: minHours,
    p_max_hours: maxHours,
  })
  if (error) throw new Error(`get_day1_onboarding_candidates: ${error.message}`)
  return (data ?? []) as Day1Candidate[]
}

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error("RESEND_API_KEY missing")
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, reply_to: REPLY_TO, to, subject, html, text, tags: [{ name: "kind", value: ALERT_KIND }] }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const dry = sp.get("dry") === "1"
  const minHours = clampInt(sp.get("min_hours"), DEFAULT_MIN_HOURS, 12, 168)
  const maxHours = clampInt(sp.get("max_hours"), DEFAULT_MAX_HOURS, minHours + 1, 336)
  const enabled = process.env.DAY1_ONBOARDING_ENABLED === "1"
  const startedAt = new Date().toISOString()

  // ── Dry run: the exact list after dedup + unsubscribe, no sends, no addresses.
  if (dry) {
    try {
      const rows = await loadCandidates(minHours, maxHours)
      const would: Array<{ username: string | null; segment: Day1Segment; fmv_usd: number | null; moment_count: number | null; alert_player: string | null; subject: string }> = []
      let unsub = 0
      let dedup = 0
      let unverified = 0
      let unusable = 0
      for (const raw of rows) {
        const r = toRecipient(raw)
        if (!r) { unusable++; continue }
        const { data: sub, error: subErr } = await (supabaseAdmin as any)
          .from("email_subscribers").select("unsubscribed_at").eq("email", r.email).maybeSingle()
        if (subErr) { unverified++; continue }
        if (sub?.unsubscribed_at) { unsub++; continue }
        const sent = await alreadySentEmail({ ownerKey: r.userId, alertKind: ALERT_KIND, subjectKey: SUBJECT_KEY, bucket: BUCKET })
        if (sent === null) { unverified++; continue }
        if (sent) { dedup++; continue }
        const alertSuggestion = r.segment === "wallet" ? await loadAlertSuggestion(r.userId) : null
        would.push({
          username: r.username,
          segment: r.segment,
          fmv_usd: r.fmvUsd,
          moment_count: r.momentCount,
          alert_player: alertSuggestion?.player ?? null,
          subject: buildDay1Subject({ segment: r.segment, username: r.username, fmvUsd: r.fmvUsd, momentCount: r.momentCount, unsubscribeUrl: "" }),
        })
      }
      return NextResponse.json({
        ok: true, dry: true, enabled, send_blocked: commercialSendBlockedReason(enabled),
        min_hours: minHours, max_hours: maxHours,
        eligible_total: rows.length, would_send: would.length,
        skipped_unsubscribed: unsub, skipped_already_sent: dedup, skipped_unverified: unverified, skipped_unusable: unusable,
        recipients: would,
      })
    } catch (e) {
      return NextResponse.json({ ok: false, dry: true, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  }

  // ── Real run: the flag AND the postal address, or nothing goes out.
  const blocked = commercialSendBlockedReason(enabled)
  if (blocked) {
    const skippedAs = blocked === "flag_off" ? "disabled" : blocked
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME, p_started_at: startedAt,
        p_rows_found: 0, p_rows_written: 0, p_rows_skipped: 0,
        p_ok: true, p_error: null, p_extra: { skipped: skippedAs },
      })
    } catch {
      /* non-fatal */
    }
    return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME, skipped: skippedAs }, { status: 202 })
  }

  const invokedMs = Date.now()
  after(async () => {
    // INVOCATION HEARTBEAT — written FIRST. A maxDuration kill takes the terminal
    // pipeline_runs row with it; this marker is the only evidence the tick ran
    // (lib/pipeline/heartbeat.ts).
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: invokedMs, extra: { min_hours: minHours, max_hours: maxHours } })
    const startedMs = Date.now()
    let ok = true
    let errMsg: string | null = null
    let found = 0
    let sent = 0
    let skipped = 0
    let guardErrors = 0
    const bySegment: Record<string, number> = { no_wallet: 0, wallet: 0 }
    const note = (m: string) => { errMsg = `${errMsg ? errMsg + "; " : ""}${m}` }

    try {
      const rows = await loadCandidates(minHours, maxHours)
      found = rows.length
      for (const raw of rows) {
        if (sent >= MAX_RECIPIENTS) break
        const r = toRecipient(raw)
        if (!r) { skipped++; continue }
        const tail = r.userId.slice(-8)

        const tok = await ensureUnsubToken(r.email)
        if ("skip" in tok) {
          skipped++
          if (tok.reason === "error") { guardErrors++; note(`guard ${tail}: ${tok.error}`) }
          continue
        }
        const sentBefore = await alreadySentEmail({ ownerKey: r.userId, alertKind: ALERT_KIND, subjectKey: SUBJECT_KEY, bucket: BUCKET })
        if (sentBefore === null) { skipped++; guardErrors++; note(`guard ${tail}: dedup_read_failed`); continue }
        if (sentBefore) { skipped++; continue }

        // 2026-11-20: optional "alert on <player>" line; a failed read omits it (never throws).
        const alertSuggestion = r.segment === "wallet" ? await loadAlertSuggestion(r.userId) : null
        const opts = {
          segment: r.segment, username: r.username, fmvUsd: r.fmvUsd, momentCount: r.momentCount, alertSuggestion,
          unsubscribeUrl: `${ORIGIN}/api/subscribe/unsubscribe?token=${tok.token}`,
        }
        const subject = buildDay1Subject(opts)
        const html = buildDay1Html(opts)
        const text = buildDay1Text(opts)

        const claim = await claimEmailDelivery({
          ownerKey: r.userId, channelUserId: r.email, alertKind: ALERT_KIND, subjectKey: SUBJECT_KEY, bucket: BUCKET,
          payload: { segment: r.segment, fmv_usd: r.fmvUsd, moment_count: r.momentCount, alert_player: alertSuggestion?.player ?? null, hours_since_signup: num(raw.hours_since_signup) },
          log: (msg) => console.log(`[${PIPELINE_NAME}] ${msg}`),
        })
        if (claim.state === "held") { skipped++; continue }
        if (claim.state === "error") { skipped++; guardErrors++; note(`guard ${tail}: ${claim.error}`); continue }

        try {
          await sendEmail(r.email, subject, html, text)
        } catch (e) {
          await claim.release()
          skipped++
          note(`send ${tail}: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        await claim.markSent()
        sent++
        bySegment[r.segment] = (bySegment[r.segment] ?? 0) + 1
      }
    } catch (e) {
      ok = false
      note(`threw: ${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME, p_started_at: startedAt,
        p_rows_found: found, p_rows_written: sent, p_rows_skipped: skipped,
        p_ok: ok, p_error: errMsg,
        p_extra: { sent, skipped, guard_errors: guardErrors, by_segment: bySegment, min_hours: minHours, max_hours: maxHours, duration_ms: Date.now() - startedMs },
      })
    } catch (logErr) {
      console.log(`[${PIPELINE_NAME}] log err: ${logErr instanceof Error ? logErr.message : String(logErr)}`)
    }
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}
