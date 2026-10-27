// app/api/subscribe/unsubscribe/route.ts
// GET  ?token=... — a confirm page with ONE button; a GET changes nothing (2026-10-27). Mail scanners and link
//        previews fetch every link in a message, so a GET that unsubscribed opted readers out who never clicked.
//        Same shape as /api/subscribe/alerts-pause.
// POST ?token=... — unsubscribes: the confirm page's form, and RFC 8058 one-click (Gmail / Yahoo POST
//        "List-Unsubscribe=One-Click" and expect the opt-out with no further step). Says "unsubscribed" only when
//        the token matched a subscriber.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

function html(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
  <style>body{background:#080808;color:#fff;font-family:'Share Tech Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{padding:32px;border:1px solid rgba(224,58,47,0.3);border-radius:10px;text-align:center;max-width:420px}
  h1{font-family:'Barlow Condensed',sans-serif;letter-spacing:.05em;color:#E03A2F;margin:0 0 12px}
  p{color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;margin:0}</style></head>
  <body><div class="card"><h1>${message}</h1><p>Change it back any time on <a href="/dashboard/notifications" style="color:#fca5a5">Notifications</a> (sign in first).</p></div></body></html>`
}

function esc(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

const HTML = { "Content-Type": "text/html", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim()
  if (!token) {
    return new NextResponse(html("Invalid unsubscribe link"), { status: 400, headers: HTML })
  }
  const action = `${req.nextUrl.pathname}?${req.nextUrl.searchParams.toString()}`
  const page = html("Unsubscribe from RPC emails?").replace(
    "<p>Change it back",
    `<form method="post" action="${esc(action)}" style="margin:0 0 14px"><button type="submit" style="background:#e55a4c;color:#0a0a0a;border:0;border-radius:10px;padding:12px 22px;font-size:16px;font-weight:700;cursor:pointer;min-height:44px">Unsubscribe</button></form><p>Change it back`,
  )
  return new NextResponse(page, { status: 200, headers: HTML })
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim()
  if (!token) {
    return new NextResponse(html("Invalid unsubscribe link"), { status: 400, headers: HTML })
  }
  try {
    const now = new Date().toISOString()
    const { data, error } = await (supabaseAdmin as any)
      .from("email_subscribers")
      .update({ unsubscribed_at: now, updated_at: now })
      .eq("verification_token", token)
      .select("id")
    if (error) {
      return new NextResponse(html("Could not unsubscribe"), { status: 500, headers: HTML })
    }
    // A token that matches no subscriber changed nothing — never tell the reader they are unsubscribed.
    if (!Array.isArray(data) || data.length === 0) {
      return new NextResponse(html("We don't recognise this link"), { status: 404, headers: HTML })
    }
    return new NextResponse(html("You've been unsubscribed"), { status: 200, headers: HTML })
  } catch {
    return new NextResponse(html("Could not unsubscribe"), { status: 500, headers: HTML })
  }
}
