// app/api/subscribe/verify/route.ts
// GET ?token=... — flips verified=true (and re-subscribes) and answers with a small PUBLIC confirmation page.
//
// 2026-11-02: this used to redirect to /dashboard?verified=true — a sign-in surface, so an anonymous
// confirmer (the whole audience of the anon capture widgets) landed on /login with nothing to say the click
// worked. It now renders its own page, the same shape as /api/subscribe/unsubscribe, so no new route has to be
// opened in proxy.ts (/api/subscribe/* is already anon-public there).
//
// Honesty: the page says "confirmed" only when the token matched a subscriber row. An update that matches
// nothing is not an error to PostgREST, so the old route told a stale/forged link "verified=true".

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>body{background:#080808;color:#fff;font-family:'Share Tech Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
  .card{padding:32px;border:1px solid rgba(224,58,47,0.3);border-radius:10px;text-align:center;max-width:420px}
  h1{font-family:'Barlow Condensed',sans-serif;letter-spacing:.05em;color:#E03A2F;margin:0 0 12px}
  p{color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;margin:0 0 10px}
  a{color:#fca5a5}</style></head>
  <body><div class="card"><h1>${title}</h1>${body}</div></body></html>`
}

const HTML = { "Content-Type": "text/html", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }

const BROWSE = `<p><a href="/insights">Browse the free market boards</a> while you wait.</p>`

function invalid(status: number, title: string) {
  return new NextResponse(
    page(title, `<p>Try the link in your most recent RPC email, or sign up again from any insights page.</p>${BROWSE}`),
    { status, headers: HTML },
  )
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim()
  if (!token) return invalid(400, "Invalid confirmation link")

  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("email_subscribers")
      // Clicking the link proves control of the inbox, so it is the ONLY place an
      // opt-out is reversed (the anonymous POST /api/subscribe never touches an
      // existing row since 2026-10-09).
      .update({ verified: true, unsubscribed_at: null, updated_at: new Date().toISOString() })
      .eq("verification_token", token)
      .select("id")

    if (error) return invalid(500, "Could not confirm right now")
    // A token that matches no subscriber changed nothing — never tell the reader they are confirmed.
    if (!Array.isArray(data) || data.length === 0) return invalid(404, "We don't recognise this link")

    return new NextResponse(
      page("You're on the list", `<p>Your email is confirmed. We'll write when there's something worth your inbox.</p>${BROWSE}`),
      { status: 200, headers: HTML },
    )
  } catch {
    return invalid(500, "Could not confirm right now")
  }
}
