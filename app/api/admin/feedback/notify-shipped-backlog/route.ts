// app/api/admin/feedback/notify-shipped-backlog/route.ts
// POST — one digest email per reader for every logged item that reached
// `shipped` BEFORE the per-transition email existed (2026-10-03), i.e. rows with
// feedback_status='shipped' AND shipped_notified_at IS NULL. Bearer
// RPC_ADMIN_TOKEN (same gate as the rest of /api/admin/feedback).
//
// Body: { note?: string, dryRun?: boolean }. dryRun lists what WOULD be sent
// (reader count, items per reader, no addresses) and sends nothing.
//
// Honesty: the receipt (shipped_notified_at) is stamped per row only after
// Resend answers 2xx; a failed send leaves the rows unstamped and is returned
// per reader. Counts are the rows the UPDATE returned. Smoke rows and rows
// with no email are skipped and counted as such.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";
import { boundedRead } from "@/lib/api/bounded-read";
import { apiErrorResponse } from "@/lib/api-error";
import {
  buildFeedbackShippedDigestSubject,
  buildFeedbackShippedDigestHtml,
  buildFeedbackShippedDigestText,
} from "@/lib/emails/feedback-shipped-email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FROM = "rpc-support@rippackscity.com";

type Row = { id: number; user_email: string | null; feedback_type: string | null; feedback_summary: string | null; shipped_at: string | null; is_smoke_test: boolean | null };

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();
  let body: { note?: unknown; dryRun?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 600) : null;
  const dryRun = body.dryRun === true;

  const { data, error } = await boundedRead(
    supabaseAdmin
      .from("support_conversations")
      .select("id,user_email,feedback_type,feedback_summary,shipped_at,is_smoke_test")
      .eq("feedback_status", "shipped")
      .is("shipped_notified_at", null)
      .not("feedback_type", "is", null)
      .order("shipped_at", { ascending: true })
      .limit(500),
    "api/admin/feedback/notify-shipped-backlog",
    8000,
  );
  if (error) return apiErrorResponse(error, "api/admin/feedback/notify-shipped-backlog");
  const rows = (data ?? []) as Row[];

  const byEmail = new Map<string, Row[]>();
  let skippedSmoke = 0;
  let skippedNoEmail = 0;
  for (const r of rows) {
    if (r.is_smoke_test) { skippedSmoke++; continue; }
    const to = (r.user_email ?? "").trim().toLowerCase();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !(r.feedback_summary ?? "").trim()) { skippedNoEmail++; continue; }
    (byEmail.get(to) ?? byEmail.set(to, []).get(to)!).push(r);
  }

  const plan = [...byEmail.entries()].map(([to, items]) => ({ reader: to.replace(/^(.).*@/, "$1…@"), items: items.length, ids: items.map((i) => i.id) }));
  if (dryRun) return NextResponse.json({ dryRun: true, readers: plan.length, skipped_smoke: skippedSmoke, skipped_no_email: skippedNoEmail, plan });

  const key = process.env.RESEND_API_KEY;
  if (!key) return NextResponse.json({ error: "RESEND_API_KEY missing" }, { status: 503 });

  const results: Array<{ reader: string; items: number; sent: boolean; stamped: number; reason?: string }> = [];
  for (const [to, items] of byEmail) {
    const reader = to.replace(/^(.).*@/, "$1…@");
    const opts = { items: items.map((i) => ({ feedbackType: i.feedback_type, summary: i.feedback_summary ?? "", shippedAt: i.shipped_at })), note };
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to, reply_to: FROM, subject: buildFeedbackShippedDigestSubject(opts), html: buildFeedbackShippedDigestHtml(opts), text: buildFeedbackShippedDigestText(opts) }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        results.push({ reader, items: items.length, sent: false, stamped: 0, reason: `resend ${res.status}${txt ? `: ${txt.slice(0, 160)}` : ""}` });
        continue;
      }
      const { data: stamped, error: stampErr } = await supabaseAdmin
        .from("support_conversations")
        .update({ shipped_notified_at: new Date().toISOString() })
        .in("id", items.map((i) => i.id))
        .is("shipped_notified_at", null)
        .select("id");
      results.push({ reader, items: items.length, sent: true, stamped: Array.isArray(stamped) ? stamped.length : 0, ...(stampErr ? { reason: `sent, but the receipt write failed: ${stampErr.message}` } : {}) });
    } catch (e) {
      results.push({ reader, items: items.length, sent: false, stamped: 0, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ readers: results.length, skipped_smoke: skippedSmoke, skipped_no_email: skippedNoEmail, results });
}
