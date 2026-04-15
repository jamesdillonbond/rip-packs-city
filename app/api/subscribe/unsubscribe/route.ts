// app/api/subscribe/unsubscribe/route.ts
// GET ?token=... — sets unsubscribed_at = now() and renders a confirmation page.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

function html(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
  <style>body{background:#080808;color:#fff;font-family:'Share Tech Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{padding:32px;border:1px solid rgba(224,58,47,0.3);border-radius:10px;text-align:center;max-width:420px}
  h1{font-family:'Barlow Condensed',sans-serif;letter-spacing:.05em;color:#E03A2F;margin:0 0 12px}
  p{color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;margin:0}</style></head>
  <body><div class="card"><h1>${message}</h1><p>You can re-subscribe any time from your profile.</p></div></body></html>`
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.trim()
  if (!token) {
    return new NextResponse(html("Invalid unsubscribe link"), { status: 400, headers: { "Content-Type": "text/html" } })
  }

  try {
    const { error } = await (supabaseAdmin as any)
      .from("email_subscribers")
      .update({ unsubscribed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("verification_token", token)

    if (error) {
      return new NextResponse(html("Could not unsubscribe"), { status: 500, headers: { "Content-Type": "text/html" } })
    }
    return new NextResponse(html("You've been unsubscribed"), { status: 200, headers: { "Content-Type": "text/html" } })
  } catch {
    return new NextResponse(html("Could not unsubscribe"), { status: 500, headers: { "Content-Type": "text/html" } })
  }
}
