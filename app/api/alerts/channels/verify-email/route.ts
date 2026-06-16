// app/api/alerts/channels/verify-email/route.ts
//
// GET ?code=...&email=... — the target of the confirmation email. Calls
// claim_channel_link('email', email, null, code) and renders a small HTML
// confirmation page. PUBLIC (added to proxy.ts isPublicPath): the click comes
// from a mail client with no RPC session cookie. Security rests on the code
// (one-time, 15-min TTL, bound to this owner+email at creation).

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { claimChannelLink } from "@/lib/alerts";

function page(title: string, body: string, ok: boolean): Response {
  const accent = ok ? "#34d399" : "#f87171";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <meta name="robots" content="noindex"/>
      <title>${title} — Rip Packs City</title></head>
      <body style="margin:0;background:#0a0a0a;color:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
        <div style="max-width:520px;margin:64px auto;padding:32px;background:#18181b;border:1px solid #27272a;border-radius:14px;text-align:center;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#e55a4c;font-weight:700;margin-bottom:10px;">Rip Packs City</div>
          <div style="font-size:40px;margin-bottom:8px;color:${accent};">${ok ? "✓" : "✗"}</div>
          <h1 style="margin:0 0 12px 0;font-size:22px;">${title}</h1>
          <p style="color:rgba(255,255,255,0.65);line-height:1.55;">${body}</p>
          <p style="margin-top:24px;"><a href="https://www.rippackscity.com/alerts" style="color:#e55a4c;font-weight:700;text-decoration:none;">Manage your alerts →</a></p>
        </div>
      </body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") || "";
  const email = (req.nextUrl.searchParams.get("email") || "").trim().toLowerCase();
  if (!code || !email) {
    return page("Invalid link", "This confirmation link is missing required information.", false);
  }

  const result = await claimChannelLink("email", email, null, code);
  if (result?.ok) {
    return page(
      "Email alerts confirmed",
      "You're all set. Deal and FMV alerts will arrive at this address based on your subscriptions.",
      true
    );
  }
  return page(
    "Couldn't confirm",
    "This link may have expired or already been used. Open your alerts settings to send a fresh confirmation.",
    false
  );
}
