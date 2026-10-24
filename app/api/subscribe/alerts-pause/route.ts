// app/api/subscribe/alerts-pause/route.ts — pause alert EMAILS without signing in
// (2026-10-24). Public via proxy.ts's /api/subscribe/* rule.
//
//   GET  ?e=<b64url email>&t=<hmac>  → a confirm page with ONE button (a GET never
//        changes anything: mail scanners and link previews fetch every link).
//   POST ?e=…&t=…                    → pauses. Accepts RFC 8058 one-click
//        (body "List-Unsubscribe=One-Click", sent by Gmail / Yahoo) and the
//        confirm page's form. Idempotent.
//
// Honesty: the page says "paused" only when the UPDATE succeeded; a failed write
// says so and points at /alerts. Nothing is returned that reveals whether the
// address has an account (a wrong token is the same 400 for every address).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeEmailParam, verifyAlertEmailPauseToken } from "@/lib/alerts/email-pause"

export const dynamic = "force-dynamic"

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="dark light"><title>${esc(title)} — Rip Packs City</title>
  <style>body{background:#0a0a0a;color:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
  .card{padding:28px;border:1px solid #27272a;border-radius:14px;background:#18181b;text-align:center;max-width:440px}
  h1{font-size:22px;margin:0 0 10px}p{color:#d4d4d8;font-size:15px;line-height:1.6;margin:0 0 14px}
  button{background:#e55a4c;color:#0a0a0a;border:0;border-radius:10px;padding:12px 22px;font-size:16px;font-weight:700;cursor:pointer;min-height:44px}
  a{color:#fca5a5}</style></head><body><main class="card"><h1>${esc(title)}</h1>${body}</main></body></html>`
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } })
}

function readParams(req: NextRequest): { email: string | null; token: string } {
  return {
    email: decodeEmailParam(req.nextUrl.searchParams.get("e")),
    token: (req.nextUrl.searchParams.get("t") ?? "").trim(),
  }
}

export async function GET(req: NextRequest) {
  const { email, token } = readParams(req)
  if (!email || !verifyAlertEmailPauseToken(email, token)) {
    return page("This link isn't valid", `<p>It may have been copied incompletely. You can manage alerts at <a href="/alerts">rippackscity.com/alerts</a>.</p>`, 400)
  }
  const action = `${req.nextUrl.pathname}?${req.nextUrl.searchParams.toString()}`
  return page(
    "Pause alert emails?",
    `<p>Rip Packs City will stop emailing price alerts to <strong>${esc(email)}</strong>. Telegram or Discord alerts, if you use them, keep working.</p>
     <form method="post" action="${esc(action)}"><button type="submit">Pause alert emails</button></form>
     <p style="margin-top:16px;font-size:13px;color:#a1a1aa">Turn them back on any time from <a href="/alerts">Alerts</a>.</p>`,
  )
}

export async function POST(req: NextRequest) {
  const { email, token } = readParams(req)
  if (!email || !verifyAlertEmailPauseToken(email, token)) {
    return page("This link isn't valid", `<p>You can manage alerts at <a href="/alerts">rippackscity.com/alerts</a>.</p>`, 400)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from("notification_channels")
    .update({ verified: false })
    .eq("channel", "email")
    .eq("channel_user_id", email)
  if (error) {
    console.error(`[alerts-pause] update failed: ${error.message}`)
    return page("We couldn't pause them", `<p>Something went wrong on our side and nothing was changed. Please try again, or turn email off at <a href="/alerts">Alerts</a>.</p>`, 500)
  }
  return page("Alert emails paused", `<p>We won't email alerts to <strong>${esc(email)}</strong>. Turn them back on any time from <a href="/alerts">Alerts</a>.</p>`)
}
