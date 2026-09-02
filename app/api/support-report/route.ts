import { NextRequest, NextResponse } from "next/server";

/* ------------------------------------------------------------------ */
/*  GET /api/support-report                                            */
/*  Protected by INGEST_SECRET_TOKEN                                   */
/*  Query: days=7, format=json|html                                    */
/* ------------------------------------------------------------------ */

import { createClient } from "@supabase/supabase-js";
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const bearer = req.headers.get("authorization") || "";
  const expected = process.env.INGEST_SECRET_TOKEN;
  const token =
    (bearer.startsWith("Bearer ") ? bearer.slice(7) : null) ||
    req.nextUrl.searchParams.get("token") ||
    req.headers.get("x-ingest-token");

  if (!expected || token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ⚠ NaN-guard + clamp, the same way /api/edition-history and
  // /api/profile/portfolio-history already do. `?days=abc` gave NaN, and
  // `new Date(NaN).toISOString()` THROWS a RangeError — this route was the one
  // sibling that never got that fix. The clamp also bounds the read below.
  const rawDays = parseInt(req.nextUrl.searchParams.get("days") || "7", 10);
  const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 7;
  const format = req.nextUrl.searchParams.get("format") || "json";
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // 🚨 THIS READ WAS UNBOUNDED, AND EVERY NUMBER BELOW IS COMPUTED FROM IT.
  // PostgREST caps every read at 1,000 rows with no error and no short page, so
  // past that the report's totalMessages, uniqueSessions, per-category counts,
  // daily volume AND its deflectionRate would all be computed over a truncated
  // population — a RATE over a truncated denominator, which is wrong in an
  // unpredictable direction rather than merely low. Measured live 2026-09-02:
  // 666 conversations in the default 7-day window, i.e. two thirds of the way to
  // the cap, and `days` was unclamped, so `?days=11` already crossed it.
  //
  // Paged by keyset on `id` (the PK). Ordering for the PAGE WALK and ordering for
  // the REPORT are different jobs: the walk needs a unique key, the report wants
  // newest-first, so the sort is re-applied in memory once every page is in.
  // Typed `any[]` deliberately: the rest of this route reads rows as `any` (the
  // client is `any` too), so typing them here only would push the change well
  // past the read this commit is fixing.
  const rows: any[] = [];
  {
    const PAGE = 1000;
    const MAX_PAGES = 200;
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      let q = supabase
        .from("support_conversations")
        .select("*")
        .gte("created_at", since)
        .not("is_smoke_test", "is", true)
        .order("id", { ascending: true })
        .limit(PAGE);
      if (cursor) q = q.gt("id", cursor);
      const { data, error: fetchErr } = await q;
      // ⛔ A partial report is worse than no report: its rate reads plausible.
      if (fetchErr) {
        return NextResponse.json({ error: fetchErr.message }, { status: 500 });
      }
      const pageRows = (data ?? []) as any[];
      rows.push(...pageRows);
      if (pageRows.length < PAGE) break;
      const next = pageRows[pageRows.length - 1]?.id as string | undefined;
      // No cursor means no progress — stop rather than re-read page 0 forever.
      if (!next || next === cursor) break;
      cursor = next;
    }
  }
  rows.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  const totalMessages = rows.length;
  const uniqueSessions = new Set(rows.map((r: any) => r.session_id)).size;
  const escalated = rows.filter((r: any) => r.escalated);
  const deflected = rows.filter((r: any) => !r.escalated);
  const deflectionRate =
    totalMessages > 0
      ? Math.round((deflected.length / totalMessages) * 1000) / 10
      : 0;

  const categoryMap: Record<string, number> = {};
  for (const r of rows) {
    const cat = r.category || "general";
    categoryMap[cat] = (categoryMap[cat] || 0) + 1;
  }
  const topCategories = Object.entries(categoryMap)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));

  const escalatedDetails = escalated.map((r: any) => ({
    sessionId: r.session_id,
    userMessage: r.user_message,
    botResponse: r.bot_response,
    escalationReason: r.escalation_reason,
    category: r.category,
    userWallet: r.user_wallet,
    pageContext: r.page_context,
    createdAt: r.created_at,
  }));

  const dailyMap: Record<string, { total: number; escalated: number }> = {};
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { total: 0, escalated: 0 };
    dailyMap[day].total++;
    if (r.escalated) dailyMap[day].escalated++;
  }
  const dailyVolume = Object.entries(dailyMap)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, stats]) => ({ date, ...stats }));

  const escalationReasons: Record<string, number> = {};
  for (const r of escalated) {
    const reason = r.escalation_reason || "Unknown";
    escalationReasons[reason] = (escalationReasons[reason] || 0) + 1;
  }
  const topEscalationReasons = Object.entries(escalationReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  const report = {
    period: { days, since, until: new Date().toISOString() },
    summary: {
      totalMessages,
      uniqueSessions,
      escalatedCount: escalated.length,
      deflectedCount: deflected.length,
      deflectionRate: `${deflectionRate}%`,
    },
    topCategories,
    dailyVolume,
    topEscalationReasons,
    escalatedDetails,
  };

  const send = req.nextUrl.searchParams.get("send") === "true";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RPC Support Report</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#e0e0e0;background:#111;">
  <h1 style="color:#E03A2F;font-size:22px;">🏙️ RPC Support Report</h1>
  <p style="color:#888;font-size:13px;">${days}-day window ending ${new Date().toLocaleDateString()}</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;">
    <tr>
      <td style="padding:12px;background:#1a1a1a;border-radius:8px 0 0 8px;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:#fff;">${totalMessages}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;">Messages</div>
      </td>
      <td style="padding:12px;background:#1a1a1a;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:#fff;">${uniqueSessions}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;">Sessions</div>
      </td>
      <td style="padding:12px;background:#1a1a1a;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:#4ade80;">${deflectionRate}%</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;">Deflected</div>
      </td>
      <td style="padding:12px;background:#1a1a1a;border-radius:0 8px 8px 0;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:#E03A2F;">${escalated.length}</div>
        <div style="font-size:11px;color:#888;text-transform:uppercase;">Escalated</div>
      </td>
    </tr>
  </table>
  ${topCategories.length > 0 ? `<h2 style="color:#fff;font-size:16px;margin-top:24px;">Top Categories</h2>
  <table style="width:100%;border-collapse:collapse;">${topCategories.map((c: any) => `<tr><td style="padding:6px 0;color:#ccc;font-size:14px;">${c.category}</td><td style="padding:6px 0;color:#fff;font-size:14px;text-align:right;font-weight:600;">${c.count}</td></tr>`).join("")}</table>` : ""}
  ${escalatedDetails.length > 0 ? `<h2 style="color:#E03A2F;font-size:16px;margin-top:24px;">Escalated (${escalated.length})</h2>
  ${escalatedDetails.slice(0, 20).map((e: any) => `<div style="background:#1a1a1a;border-left:3px solid #E03A2F;padding:12px;margin:8px 0;border-radius:0 8px 8px 0;">
    <div style="font-size:12px;color:#888;">${new Date(e.createdAt).toLocaleString()} · ${e.category}${e.userWallet ? ` · ${e.userWallet.slice(0, 10)}...` : ""}</div>
    <div style="font-size:14px;color:#fff;margin:6px 0;"><strong>User:</strong> ${e.userMessage}</div>
    <div style="font-size:13px;color:#aaa;"><strong>Reason:</strong> ${e.escalationReason}</div>
  </div>`).join("")}` : "<p style='color:#4ade80;'>No escalations this period</p>"}
</body></html>`;

  if (format === "html" || send) {
    if (process.env.RESEND_API_KEY) {
      try {
        const weekOf = new Date().toISOString().slice(0, 10);
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "RPC Support <noreply@rippackscity.com>",
            to: [process.env.ALERT_EMAIL],
            subject: `RPC Support Report — Week of ${weekOf}`,
            html,
          }),
        });
        console.log("[support-report] email sent");
      } catch (err) {
        console.log("[support-report] email send failed", err);
      }
    } else {
      console.log("[support-report] email skipped (no key)");
    }
  }

  if (format === "html") {
    return new NextResponse(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return NextResponse.json(report);
}
