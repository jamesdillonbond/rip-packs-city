// lib/welcome/send-account-welcome.ts
//
// Send the transactional account-welcome email EXACTLY ONCE per account, from
// the server, fail-soft (platform review 2026-10-11, M2).
//
// HOW ONCE IS GUARANTEED. Not by this module remembering anything — by the
// database. `claim_welcome_email(p_user_id)` (migration 20261012054000) is one
// atomic UPDATE that flips user_profiles.welcome_state from 'pending' to 'sent'
// and returns true to exactly one caller per account; every other caller, on
// any path, concurrently or later, gets false and this module sends nothing.
// Accounts that predate the migration are 'pre_existing' and can never be
// claimed. So BOTH profile-creation paths (app/api/auth/callback/route.ts and
// /api/profile/touch) may call this after their upsert without coordinating.
//
// FAIL-SOFT, BOTH WAYS.
//   * Nothing here throws. A failed claim, a failed send, a thrown fetch — each
//     is logged and returned as a status; the caller is a sign-in, and a
//     sign-in must never fail because a welcome did not go out.
//   * A failed SEND is not a sent email. `record_welcome_email_failure` reverts
//     the claim so the next sign-in retries (bounded at 3 attempts by the SQL).
//     Without that revert, a Resend outage during someone's first sign-in would
//     silently mean they are never welcomed — the "swallowed write error +
//     hardcoded ok" shape from the honesty canon.
//
// ⚠ NOT WIRED into any auth path in this batch — see the migration header for
// why (two creation paths, one owned elsewhere, neither knows "new"). Wiring is
// one line per path: `void sendAccountWelcomeOnce({ userId, email })`.
//
// `db` and `send` are injectable so every branch is testable without a database
// or Resend; defaults are supabaseAdmin and a Resend POST with the same From
// address lib/allow-list/prewarm.ts uses.

import { supabaseAdmin } from "@/lib/supabase"
import {
  buildAccountWelcomeHtml,
  buildAccountWelcomeSubject,
  buildAccountWelcomeText,
} from "@/lib/emails/account-welcome-email"

/** Same literal as lib/allow-list/prewarm.ts FROM_ADDRESS — pinned by test. */
export const WELCOME_FROM_ADDRESS = "Rip Packs City <noreply@rippackscity.com>"

const RESEND_TIMEOUT_MS = 10_000

export interface SendEmailArgs {
  from: string
  to: string
  subject: string
  html: string
  text: string
}

export type SendResult = { ok: true } | { ok: false; error: string }

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

export interface SendAccountWelcomeDeps {
  db?: RpcClient
  send?: (args: SendEmailArgs) => Promise<SendResult>
  log?: (line: string) => void
}

export type AccountWelcomeStatus =
  /** Claimed and the send succeeded. */
  | { status: "sent" }
  /** The claim returned false: already sent, pre-existing, no profile row, or retries exhausted. Nothing sent. */
  | { status: "not_claimed" }
  /** The claim RPC itself failed (or threw). Nothing sent; nothing to revert. */
  | { status: "claim_failed"; error: string }
  /** Claimed, send failed; the claim was reverted so a later sign-in retries. */
  | { status: "send_failed"; error: string }
  /** Bad input (no userId / no email). Nothing attempted. */
  | { status: "skipped"; error: string }

/** Default sender: Resend over fetch, bounded, never throws. */
export async function sendViaResend(args: SendEmailArgs): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set" }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), RESEND_TIMEOUT_MS)
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: args.from, to: [args.to], subject: args.subject, html: args.html, text: args.text }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Resend threw: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    clearTimeout(timer)
  }
}

export async function sendAccountWelcomeOnce(
  input: { userId: string | null | undefined; email: string | null | undefined },
  deps: SendAccountWelcomeDeps = {}
): Promise<AccountWelcomeStatus> {
  const db = deps.db ?? (supabaseAdmin as unknown as RpcClient)
  const send = deps.send ?? sendViaResend
  const log = deps.log ?? ((line: string) => console.log(line))

  const userId = typeof input.userId === "string" ? input.userId.trim() : ""
  const email = typeof input.email === "string" ? input.email.trim() : ""
  if (!userId || !email || !email.includes("@")) {
    return { status: "skipped", error: "missing userId or email" }
  }

  // 1. Claim — the only decision point. true exactly once per account.
  let claimed = false
  try {
    const { data, error } = await db.rpc("claim_welcome_email", { p_user_id: userId })
    if (error) {
      log(`[welcome] claim failed for ${userId}: ${error.message ?? "unknown error"}`)
      return { status: "claim_failed", error: error.message ?? "unknown error" }
    }
    claimed = data === true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`[welcome] claim threw for ${userId}: ${msg}`)
    return { status: "claim_failed", error: msg }
  }
  if (!claimed) return { status: "not_claimed" }

  // 2. Send. Any failure reverts the claim so the next sign-in can retry.
  let result: SendResult
  try {
    const opts = { email }
    result = await send({
      from: WELCOME_FROM_ADDRESS,
      to: email,
      subject: buildAccountWelcomeSubject(),
      html: buildAccountWelcomeHtml(opts),
      text: buildAccountWelcomeText(opts),
    })
  } catch (e) {
    result = { ok: false, error: `send threw: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (result.ok) {
    log(`[welcome] sent to account ${userId}`)
    return { status: "sent" }
  }

  log(`[welcome] send failed for ${userId}: ${result.error}`)
  try {
    const { error } = await db.rpc("record_welcome_email_failure", { p_user_id: userId, p_error: result.error })
    if (error) log(`[welcome] could not record the failure for ${userId}: ${error.message ?? "unknown error"}`)
  } catch (e) {
    log(`[welcome] recording the failure threw for ${userId}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { status: "send_failed", error: result.error }
}
