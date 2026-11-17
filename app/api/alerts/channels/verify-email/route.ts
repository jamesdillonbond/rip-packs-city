// app/api/alerts/channels/verify-email/route.ts
//
// The target of the confirmation email. PUBLIC (proxy.ts isPublicPath, every
// method): the click comes from a mail client with no RPC session cookie.
// Security rests on the code (one-time, 15-min TTL, bound to this owner+email
// at creation).
//
// GET ?code=...&email=... renders a "Confirm" button and claims NOTHING; the
// button POSTs the same code+email and the POST calls
// claim_channel_link('email', email, null, code).
//
// ⚠ Why the split (2026-11-07 review): the claim used to run on the GET, and a
// mail provider's link scanner (Outlook Safe Links, corporate gateways) fetches
// every link in a message before the collector sees it — that prefetch spent
// the one-time code, and the collector's own click then read "This link may
// have expired or already been used". Scanners follow links; they do not
// submit forms.

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { claimChannelLink } from "@/lib/alerts";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

type Tone = "ok" | "fail" | "ask";

function page(title: string, body: string, tone: Tone, extra = "", status?: number): Response {
  const accent = tone === "ok" ? "#34d399" : tone === "fail" ? "#f87171" : "#e55a4c";
  const glyph = tone === "ok" ? "✓" : tone === "fail" ? "✗" : "✉";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <meta name="robots" content="noindex"/>
      <title>${title} — Rip Packs City</title></head>
      <body style="margin:0;background:#0a0a0a;color:#fafafa;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
        <div style="max-width:520px;margin:64px auto;padding:32px;background:#18181b;border:1px solid #27272a;border-radius:14px;text-align:center;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#e55a4c;font-weight:700;margin-bottom:10px;">Rip Packs City</div>
          <div style="font-size:40px;margin-bottom:8px;color:${accent};">${glyph}</div>
          <h1 style="margin:0 0 12px 0;font-size:22px;">${title}</h1>
          <p style="color:rgba(255,255,255,0.65);line-height:1.55;">${body}</p>
          ${extra}
          <p style="margin-top:24px;"><a href="https://www.rippackscity.com/alerts" style="color:#e55a4c;font-weight:700;text-decoration:none;">Manage your alerts →</a></p>
        </div>
      </body></html>`,
    {
      status: status ?? (tone === "fail" ? 400 : 200),
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }
  );
}

const MISSING = () => page("Invalid link", "This confirmation link is missing required information.", "fail");

function confirmForm(code: string, email: string): string {
  return (
    `<form method="post" action="/api/alerts/channels/verify-email" style="margin:24px 0 0 0;">` +
    `<input type="hidden" name="code" value="${esc(code)}"/>` +
    `<input type="hidden" name="email" value="${esc(email)}"/>` +
    `<button type="submit" style="display:inline-block;padding:13px 28px;background:#e55a4c;color:#0a0a0a;font-weight:800;border:0;border-radius:8px;font-size:15px;cursor:pointer;">Confirm email alerts</button>` +
    `</form>`
  );
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") || "";
  const email = (req.nextUrl.searchParams.get("email") || "").trim().toLowerCase();
  if (!code || !email) return MISSING();

  return page(
    "Confirm email alerts",
    `Send Rip Packs City deal and FMV alerts to <strong>${esc(email)}</strong>?`,
    "ask",
    confirmForm(code, email)
  );
}

export async function POST(req: NextRequest) {
  let code = "";
  let email = "";
  try {
    const fd = await req.formData();
    code = String(fd.get("code") ?? "");
    email = String(fd.get("email") ?? "").trim().toLowerCase();
  } catch {
    return MISSING();
  }
  if (!code || !email) return MISSING();

  const result = await claimChannelLink("email", email, null, code);
  if (result?.ok) {
    return page(
      "Email alerts confirmed",
      "You're all set. Deal and FMV alerts will arrive at this address based on your subscriptions.",
      "ok"
    );
  }
  // A failed CALL is not an expired code: say so, keep the button, 503 (retryable).
  if (!result || result.error === "server_error") {
    return page(
      "Couldn't confirm right now",
      "Something went wrong on our side. Your link is still good — try again in a moment.",
      "fail",
      confirmForm(code, email),
      503
    );
  }
  return page(
    "Couldn't confirm",
    "This link may have expired or already been used. Open your alerts settings to send a fresh confirmation.",
    "fail"
  );
}
