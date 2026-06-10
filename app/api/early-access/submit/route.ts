// app/api/early-access/submit/route.ts
//
// Soft-launch sign-up endpoint. Accepts the /early-access form payload, runs
// minimal validation, hashes the request IP, and forwards to the
// submit_allow_list_request RPC via the service-role Supabase client.
//
// Returns the RPC's jsonb shape verbatim — { ok, duplicate, status } — so the
// page can render the right copy. Never exposes the internal table.
//
// On a first-time submission (duplicate=false) we also fire-and-forget a
// Telegram notification to the admin chat using the same TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID env vars the support-chat escalate_to_human urgency=high
// path uses. Duplicate rows just merge collections into an existing record so
// they intentionally do not re-page Trevor.

import { NextRequest, NextResponse, after } from "next/server"
import { createHash } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase"

const WALLET_RE = /^0x[a-fA-F0-9]{16}$/
const ALL_PUBLISHED_COLLECTIONS = [
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "disney_pinnacle",
  "ufc_strike",
] as const
const ALLOWED_COLLECTIONS = new Set<string>(ALL_PUBLISHED_COLLECTIONS)

const SITE_ORIGIN =
  (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "") ||
  "https://www.rippackscity.com"

// The slow auto-approval pass (a wallet-search, ~1-17s) runs in after(), so
// give the lambda headroom beyond the instant thank-you response. Well under
// the Vercel Pro 800s cap.
export const maxDuration = 60

type AutoApprovalAction =
  | "auto_approved"
  | "pending_with_score"
  | "pending"
  | "rejected"

interface AutoApprovalOutcome {
  eligible: boolean
  score: number
  reasons: string[]
  blocked_by: string[]
  action: AutoApprovalAction
}

// Lenient policy (adopted 2026-06-10): an unknown-to-RPC real collector tops
// out around 70-85 (on-chain 40 [+20 substantial] + gmail 10 + maybe sales 15),
// below the strict 90 bar — so without this they'd wait in the pending queue
// until an admin wakes up. Auto-approve at >=60 when the wallet has on-chain
// moments and nothing blocks. The fast inline pass (no on-chain count) never
// sees wallet_has_onchain_moments, so it keeps the historical >=90 behavior.
function decideAutoApprovalAction(
  score: number,
  reasons: string[],
  blockedBy: string[]
): AutoApprovalAction {
  if (blockedBy.length > 0) return "rejected"
  const hasOnchain = reasons.includes("wallet_has_onchain_moments")
  if (score >= 90 || (score >= 60 && hasOnchain)) return "auto_approved"
  if (score >= 60) return "pending_with_score"
  return "pending"
}

// Applies a scored decision to the allow_list row. Safe to run twice (the fast
// inline pass, then the on-chain slow pass in after()) — every branch is a
// plain UPDATE keyed by id. "pending" writes nothing, matching prior behavior.
async function applyAutoApprovalDecision(
  rowId: string,
  score: number,
  reasons: string[],
  blockedBy: string[]
): Promise<AutoApprovalOutcome> {
  const action = decideAutoApprovalAction(score, reasons, blockedBy)
  const nowIso = new Date().toISOString()
  if (action === "rejected") {
    await supabaseAdmin
      .from("allow_list")
      .update({ status: "rejected", reject_reason: blockedBy[0], auto_approval_score: score })
      .eq("id", rowId)
  } else if (action === "auto_approved") {
    await supabaseAdmin
      .from("allow_list")
      .update({
        status: "active",
        auto_approved_at: nowIso,
        auto_approval_score: score,
        approved_by: "auto",
        approved_at: nowIso,
      })
      .eq("id", rowId)
  } else if (action === "pending_with_score") {
    await supabaseAdmin
      .from("allow_list")
      .update({ auto_approval_score: score })
      .eq("id", rowId)
  }
  return {
    eligible: action === "auto_approved",
    score,
    reasons,
    blocked_by: blockedBy,
    action,
  }
}

// Fire-and-forget kick of the prewarm batch drain so a freshly auto-approved
// user gets seeded/backfilled without waiting for the next cron tick. The drain
// ACKs 202 and does the work in its own after(); it claims status=active +
// prewarm_status=pending + wallet rows under SKIP LOCKED, so this row is picked
// up. Auth is Bearer CRON_SECRET (the drain route's gate).
async function firePrewarmDrain(): Promise<void> {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.log("[early-access/submit] CRON_SECRET missing — skip prewarm-drain kick")
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    await fetch(`${SITE_ORIGIN}/api/admin/allow-list/prewarm-drain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: controller.signal,
    })
  } catch (err) {
    console.log(
      `[early-access/submit] prewarm-drain kick threw: ${err instanceof Error ? err.message : String(err)}`
    )
  } finally {
    clearTimeout(timer)
  }
}

function hashIp(ip: string | null): string | null {
  if (!ip) return null
  const trimmed = ip.trim()
  if (!trimmed) return null
  return createHash("sha256").update(trimmed).digest("hex")
}

function getClientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0]?.trim() || null
  const real = req.headers.get("x-real-ip")
  if (real) return real.trim() || null
  return null
}

async function notifyTelegramAndMark(opts: {
  rowId: string
  email: string
  walletAddr: string | null
  username: string | null
  collections: string[]
  source: string
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.log("[early-access/submit] telegram env missing — skip notify")
    return
  }

  const adminLink = `${SITE_ORIGIN}/admin/allow-list?focus=${opts.rowId}`
  const identityLines: string[] = []
  if (opts.walletAddr) identityLines.push(`Wallet: ${opts.walletAddr}`)
  if (opts.username) identityLines.push(`Username: ${opts.username}`)
  const collectionsLine =
    opts.collections.length > 0 ? opts.collections.join(", ") : "(none)"

  const text = [
    "🆕 RPC Early Access Request",
    `Email: ${opts.email}`,
    ...identityLines,
    `Collections: ${collectionsLine}`,
    `Source: ${opts.source}`,
    "",
    `Triage: ${adminLink}`,
  ].join("\n")

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.log(
        `[early-access/submit] telegram send failed status=${res.status} body=${body.slice(0, 200)}`
      )
      return
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[early-access/submit] telegram throw: ${msg}`)
    return
  }

  const { error: markErr } = await supabaseAdmin
    .from("allow_list")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", opts.rowId)
  if (markErr) {
    console.log(
      `[early-access/submit] notified_at update failed for row=${opts.rowId}: ${markErr.message}`
    )
  }
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const data = (body ?? {}) as {
    email?: unknown
    wallet?: unknown
    username?: unknown
    collections?: unknown
  }

  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : ""
  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "Email is required." }, { status: 400 })
  }

  const walletRaw = typeof data.wallet === "string" ? data.wallet.trim() : ""
  const wallet = walletRaw.length > 0 ? walletRaw : null
  if (wallet && !WALLET_RE.test(wallet)) {
    return NextResponse.json(
      { ok: false, error: "Wallet must be 0x followed by exactly 16 hex characters." },
      { status: 400 }
    )
  }

  const usernameRaw = typeof data.username === "string" ? data.username.trim() : ""
  const username = usernameRaw.length > 0 ? usernameRaw : null

  if (!wallet && !username) {
    return NextResponse.json(
      { ok: false, error: "Provide either a Flow wallet address or a username." },
      { status: 400 }
    )
  }

  const collectionsInput = Array.isArray(data.collections) ? data.collections : []
  const collectionsValidated = Array.from(
    new Set(
      collectionsInput
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => ALLOWED_COLLECTIONS.has(c))
    )
  )
  // Form copy is "Pick any that apply. Skip if none." — empty selection is a
  // valid submission shape, not a validation error. But persisting [] sends a
  // no-op orchestrator prewarm that finishes in ~0.2s without scanning
  // anything (see juiceshack 2026-05-09). Default empty → all 5 published
  // slugs so the prewarm actually walks the wallet across every collection.
  const collections =
    collectionsValidated.length > 0
      ? collectionsValidated
      : [...ALL_PUBLISHED_COLLECTIONS]

  // Dedup: reject when (lower(username), wallet_addr) already has an active
  // allow_list row under a different email. Catches the samwise222
  // typo-fix-double-signup pattern (same wallet, same handle, two emails both
  // approved). Only fires when both identifiers are present — otherwise we
  // can't be sure we're matching the same person.
  if (wallet && username) {
    // Match the RPC's storage shape: submit_allow_list_request lowercases both
    // wallet_addr and username at INSERT time. Comparing raw mixed-case form
    // input against stored lowercase rows would silently miss duplicates.
    const { data: dupRows, error: dupErr } = await supabaseAdmin
      .from("allow_list")
      .select("email")
      .eq("status", "active")
      .eq("wallet_addr", wallet.toLowerCase())
      .ilike("username", username)
      .limit(1)
    if (dupErr) {
      console.error("[early-access/submit] dedup lookup error", dupErr)
    } else if (dupRows && dupRows.length > 0) {
      const existingEmail = (dupRows[0] as { email?: string }).email
      const isSameEmail =
        typeof existingEmail === "string" &&
        existingEmail.trim().toLowerCase() === email
      if (!isSameEmail) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "This wallet and username are already approved under a different email. Sign in with that email instead — we send a magic link.",
            duplicate: true,
            existing_account: true,
          },
          { status: 409 }
        )
      }
    }
  }

  const userAgent = req.headers.get("user-agent") ?? null
  const ipHash = hashIp(getClientIp(req))
  const source = "early_access_form"

  const { data: rpc, error } = await supabaseAdmin.rpc("submit_allow_list_request", {
    p_email: email,
    p_wallet_addr: wallet,
    p_username: username,
    p_collections: collections,
    p_source: source,
    p_user_agent: userAgent,
    p_ip_hash: ipHash,
  })

  if (error) {
    console.error("[early-access/submit] RPC error", error)
    return NextResponse.json(
      { ok: false, error: "We couldn't save your request. Please try again." },
      { status: 500 }
    )
  }

  // RPC contract: { ok, duplicate, status }
  const result = (rpc ?? {}) as { ok?: boolean; duplicate?: boolean; status?: string }
  if (result.ok === false) {
    return NextResponse.json(
      { ok: false, error: "Request rejected.", ...result },
      { status: 400 }
    )
  }

  const isDuplicate = Boolean(result.duplicate)

  // Auto-approval — fast inline pass on first-time submissions. Scores on the
  // signals available synchronously (email domain, prior sales, etc.) via
  // auto_approve_eligible(); the on-chain Top Shot moment count is folded in
  // by the slow pass in after() below (a wallet-search is too slow to block
  // the thank-you response). Decisions are advisory — failures are non-fatal.
  let autoApprovalOutcome: AutoApprovalOutcome | null = null
  let autoApprovalRowId: string | null = null

  if (!isDuplicate) {
    try {
      const { data: scoreResult } = await supabaseAdmin.rpc("auto_approve_eligible", {
        p_email: email,
        p_wallet_addr: wallet,
        p_username: username,
        p_ip_hash: ipHash,
      })
      const scored = (scoreResult ?? {}) as {
        score?: number
        reasons?: string[]
        blocked_by?: string[]
      }
      const score = typeof scored.score === "number" ? scored.score : 0
      const reasons = Array.isArray(scored.reasons) ? scored.reasons : []
      const blockedBy = Array.isArray(scored.blocked_by) ? scored.blocked_by : []

      const { data: row } = await supabaseAdmin
        .from("allow_list")
        .select("id")
        .eq("email", email)
        .maybeSingle()

      if (row?.id) {
        autoApprovalRowId = row.id as string
        autoApprovalOutcome = await applyAutoApprovalDecision(
          autoApprovalRowId,
          score,
          reasons,
          blockedBy
        )
      }
    } catch (autoErr) {
      console.warn(
        "[early-access/submit] auto_approve_eligible failed (continuing):",
        autoErr instanceof Error ? autoErr.message : String(autoErr)
      )
    }
  }

  // First-time submissions: page Trevor on Telegram and stamp notified_at.
  // Duplicates just merge collections into an existing row so they should not
  // re-page. Run after the response so the user's thank-you state is instant.
  if (!isDuplicate) {
    after(async () => {
      // ── Slow auto-approval pass ──────────────────────────────────────
      // Fold the real on-chain Top Shot moment count into the score. Most
      // genuine collectors are unknown to RPC at submit time, so the fast
      // inline pass scores them on email/sales only and they sit pending.
      // Re-score with p_onchain_moments and (under the lenient policy)
      // auto-approve real collectors in seconds. Only acts while the row is
      // still pending — never clobbers a fast-path auto_approved/rejected.
      if (wallet && autoApprovalRowId) {
        try {
          const { data: cur } = await supabaseAdmin
            .from("allow_list")
            .select("status")
            .eq("id", autoApprovalRowId)
            .maybeSingle()
          const curStatus = (cur as { status?: string } | null)?.status
          if (curStatus !== "active" && curStatus !== "rejected") {
            let totalMoments: number | null = null
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 20_000)
            try {
              const res = await fetch(`${SITE_ORIGIN}/api/wallet-search`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ input: wallet, collection: "nba-top-shot" }),
                signal: controller.signal,
              })
              if (res.ok) {
                const wsBody = (await res.json().catch(() => null)) as {
                  summary?: { totalMoments?: number }
                } | null
                const tm = wsBody?.summary?.totalMoments
                if (typeof tm === "number" && Number.isFinite(tm)) totalMoments = tm
              }
            } finally {
              clearTimeout(timer)
            }

            if (totalMoments !== null) {
              const { data: scoreResult } = await supabaseAdmin.rpc("auto_approve_eligible", {
                p_email: email,
                p_wallet_addr: wallet,
                p_username: username,
                p_ip_hash: ipHash,
                p_onchain_moments: totalMoments,
              })
              const scored = (scoreResult ?? {}) as {
                score?: number
                reasons?: string[]
                blocked_by?: string[]
              }
              const score = typeof scored.score === "number" ? scored.score : 0
              const reasons = Array.isArray(scored.reasons) ? scored.reasons : []
              const blockedBy = Array.isArray(scored.blocked_by) ? scored.blocked_by : []
              const outcome = await applyAutoApprovalDecision(
                autoApprovalRowId,
                score,
                reasons,
                blockedBy
              )
              console.log(
                `[early-access/submit] slow auto-approval row=${autoApprovalRowId} onchain=${totalMoments} score=${score} action=${outcome.action}`
              )
              if (outcome.action === "auto_approved") await firePrewarmDrain()
            }
          }
        } catch (slowErr) {
          console.log(
            `[early-access/submit] slow auto-approval threw: ${slowErr instanceof Error ? slowErr.message : String(slowErr)}`
          )
        }
      }

      // ── Telegram signup ping (every first-time signup) ───────────────
      const { data: row, error: lookupErr } = await supabaseAdmin
        .from("allow_list")
        .select("id, collections")
        .eq("email", email)
        .maybeSingle()
      if (lookupErr) {
        console.log(
          `[early-access/submit] lookup-after-submit failed for ${email}: ${lookupErr.message}`
        )
        return
      }
      if (!row) {
        console.log(`[early-access/submit] row not found post-submit for ${email}`)
        return
      }
      await notifyTelegramAndMark({
        rowId: row.id as string,
        email,
        walletAddr: wallet,
        username,
        collections: Array.isArray(row.collections)
          ? (row.collections as string[])
          : collections,
        source,
      })
    })
  }

  return NextResponse.json({
    ok: true,
    duplicate: isDuplicate,
    status:
      autoApprovalOutcome?.action === "auto_approved"
        ? "active"
        : autoApprovalOutcome?.action === "rejected"
          ? "rejected"
          : (result.status ?? "pending"),
    auto_approval: autoApprovalOutcome,
  })
}
