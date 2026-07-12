// app/api/cron/check-alerts/route.ts
//
// RETIRED 2026-07-12. This was the first-generation per-user FMV-alert
// deliverer: it read the `fmv_alerts` table directly and, for telegram
// alerts, sent to `TELEGRAM_CHAT_ID` — the OPS/sentinel chat (Trevor), not
// the subscriber. That was a mis-route: every user's telegram FMV alert went
// to the operator. The `fmv_alerts` table is now empty (0 rows) and the path
// is fully superseded by the omni-channel outbox:
//
//   canonical: /api/cron/alerts-dispatch  (dispatch_triggered_fmv_alerts +
//              dispatchDueDealAlerts → alert_deliveries outbox)
//           →  /api/cron/alerts-send      (per-user delivery to verified
//              notification_channels: email / TELEGRAM_USER_BOT_TOKEN / discord)
//
// This route is kept as an auth-gated no-op (returns 410 semantics as a 200
// body so any lingering external cron entry stops cleanly instead of erroring)
// and NEVER sends a notification. OPERATOR: remove the cron-job.org entry that
// still hits this path.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or Bearer ${CRON_SECRET}

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

function handler(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const ingestToken = process.env.INGEST_SECRET_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const isValid =
    authHeader != null &&
    (authHeader === `Bearer ${ingestToken}` ||
      authHeader === `Bearer ${cronSecret}`);
  if (!isValid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    deprecated: true,
    checked: 0,
    triggered: 0,
    notifications_sent: 0,
    message:
      "Retired: FMV alert delivery moved to the alerts-dispatch → alerts-send outbox. This endpoint no longer sends anything. Remove the cron entry.",
    canonical: ["/api/cron/alerts-dispatch", "/api/cron/alerts-send"],
  });
}

export const GET = handler;
export const POST = handler;
