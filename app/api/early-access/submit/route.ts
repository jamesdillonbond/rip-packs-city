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
const ALLOWED_COLLECTIONS = new Set([
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "disney_pinnacle",
  "ufc_strike",
])

const SITE_ORIGIN =
  (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "") ||
  "https://www.rippackscity.com"

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
  const collections = Array.from(
    new Set(
      collectionsInput
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => ALLOWED_COLLECTIONS.has(c))
    )
  )

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

  // First-time submissions: page Trevor on Telegram and stamp notified_at.
  // Duplicates just merge collections into an existing row so they should not
  // re-page. Run after the response so the user's thank-you state is instant.
  if (!isDuplicate) {
    after(async () => {
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
    status: result.status ?? "pending",
  })
}
