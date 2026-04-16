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
  const token =
    req.nextUrl.searchParams.get("token") ||
    req.headers.get("x-ingest-token");

  if (token !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const days = parseInt(req.nextUrl.searchParams.get("days") || "7", 10);
  const format = req.nextUrl.searchParams.get("format") || "json";
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: allRows, error: fetchErr } = await supabase
    .from("support_conversations")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  const rows = allRows || [];
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
            from: "RPC Support <onboarding@resend.dev>",
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
