// app/api/cron/check-alerts/route.ts
// Cron endpoint: checks all active FMV alerts and sends notifications
// Auth: Bearer ${INGEST_SECRET_TOKEN}
// Returns: { checked, triggered, notifications_sent, errors }

export const maxDuration = 25;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function handler(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.INGEST_SECRET_TOKEN;
  if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const errors: string[] = [];
  let checked = 0;
  let triggered = 0;
  let notifications_sent = 0;

  try {
    // Fetch all active alerts not triggered in last 24 hours
    const { data: alerts, error: alertErr } = await supabase
      .from("fmv_alerts")
      .select("*")
      .eq("active", true)
      .or("last_triggered_at.is.null,last_triggered_at.lt." + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (alertErr) throw new Error(`Failed to fetch alerts: ${alertErr.message}`);
    if (!alerts || alerts.length === 0) {
      return NextResponse.json({ checked: 0, triggered: 0, notifications_sent: 0, errors: [] });
    }

    checked = alerts.length;

    // Group alerts by edition_key to minimize lookups
    const alertsByEdition = new Map<string, any[]>();
    for (const alert of alerts) {
      const group = alertsByEdition.get(alert.edition_key) ?? [];
      group.push(alert);
      alertsByEdition.set(alert.edition_key, group);
    }

    const editionKeys = Array.from(alertsByEdition.keys());

    // Fetch edition internal IDs
    const { data: editionRows } = await supabase
      .from("editions")
      .select("id, external_id")
      .in("external_id", editionKeys);

    const extToId = new Map<string, string>();
    for (const row of editionRows ?? []) {
      extToId.set(row.external_id, row.id);
    }

    // Fetch latest FMV for each edition
    const internalIds = Array.from(extToId.values());
    const fmvMap = new Map<string, number>();
    if (internalIds.length) {
      const { data: fmvRows } = await supabase
        .from("fmv_snapshots")
        .select("edition_id, fmv_usd, computed_at")
        .in("edition_id", internalIds)
        .order("computed_at", { ascending: false });

      for (const row of fmvRows ?? []) {
        // Map back to external_id
        for (const [ext, int] of extToId.entries()) {
          if (int === row.edition_id && !fmvMap.has(ext)) {
            fmvMap.set(ext, row.fmv_usd);
          }
        }
      }
    }

    // Fetch current low_ask from cached_listings (min price_usd for nba_top_shot)
    const lowAskMap = new Map<string, number>();
    if (editionKeys.length) {
      const { data: listingRows } = await supabase
        .from("cached_listings")
        .select("edition_key, price_usd")
        .in("edition_key", editionKeys)
        .eq("collection", "nba_top_shot")
        .order("price_usd", { ascending: true });

      for (const row of listingRows ?? []) {
        // Keep only the lowest price per edition_key
        if (!lowAskMap.has(row.edition_key)) {
          lowAskMap.set(row.edition_key, row.price_usd);
        }
      }
    }

    // Evaluate each alert and send notifications for triggered ones
    const triggeredAlertIds: string[] = [];

    for (const [editionKey, editionAlerts] of alertsByEdition) {
      const fmv = fmvMap.get(editionKey) ?? null;
      const low_ask = lowAskMap.get(editionKey) ?? null;

      for (const alert of editionAlerts) {
        // Skip if FMV or low_ask is null
        if (fmv == null || low_ask == null) continue;

        const discount_pct = ((fmv - low_ask) / fmv) * 100;
        let isTriggered = false;

        if (alert.alert_type === "below_fmv_pct") {
          isTriggered = discount_pct >= alert.threshold;
        } else if (alert.alert_type === "below_price") {
          isTriggered = low_ask <= alert.threshold;
        }

        if (!isTriggered) continue;

        triggered++;
        triggeredAlertIds.push(alert.id);
        const roundedDiscount = Math.round(discount_pct);

        console.log(
          `[check-alerts] Triggered: ${alert.player_name ?? editionKey} — ` +
          `$${low_ask} ask, ${roundedDiscount}% below FMV $${fmv.toFixed(2)}, ` +
          `alert_type=${alert.alert_type}, threshold=${alert.threshold}`
        );

        // Send notifications based on channel
        const channel = alert.channel;
        const recipientEmail = alert.notification_email || process.env.ALERT_EMAIL;

        // Email notification
        if ((channel === "email" || channel === "both") && process.env.RESEND_API_KEY && recipientEmail) {
          try {
            const playerName = alert.player_name ?? "Unknown Player";
            const setName = alert.set_name ?? "";

            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "rpc-alerts@rippackscity.com",
                to: recipientEmail,
                subject: `🎯 RPC Alert: ${playerName} is ${roundedDiscount}% below FMV`,
                html: `
                  <h2>🎯 RPC Price Alert Triggered</h2>
                  <p><strong>Player:</strong> ${playerName}</p>
                  <p><strong>Set:</strong> ${setName}</p>
                  <p><strong>Current Ask:</strong> $${low_ask.toFixed(2)}</p>
                  <p><strong>FMV:</strong> $${fmv.toFixed(2)}</p>
                  <p><strong>Discount:</strong> ${roundedDiscount}% below FMV</p>
                  <br/>
                  <p><a href="https://rip-packs-city.vercel.app/nba-top-shot/market">View on RPC Market →</a></p>
                `,
              }),
            });
            notifications_sent++;
          } catch (err: any) {
            errors.push(`Email failed for ${alert.id}: ${err.message}`);
          }
        }

        // Telegram notification
        if ((channel === "telegram" || channel === "both") && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
          try {
            const playerName = alert.player_name ?? "Unknown";
            const setName = alert.set_name ?? "";

            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: `🎯 Alert: ${playerName} ${setName} — $${low_ask.toFixed(2)} ask, ${roundedDiscount}% below FMV $${fmv.toFixed(2)}`,
              }),
            });
            notifications_sent++;
          } catch (err: any) {
            errors.push(`Telegram failed for ${alert.id}: ${err.message}`);
          }
        }
      }
    }

    // Update last_triggered_at for all triggered alerts
    if (triggeredAlertIds.length) {
      const { error: updateErr } = await supabase
        .from("fmv_alerts")
        .update({ last_triggered_at: new Date().toISOString() })
        .in("id", triggeredAlertIds);

      if (updateErr) {
        errors.push(`Failed to update last_triggered_at: ${updateErr.message}`);
      }
    }

    return NextResponse.json({ checked, triggered, notifications_sent, errors });
  } catch (err: any) {
    console.error("[check-alerts]", err);
    return NextResponse.json(
      { checked, triggered, notifications_sent, errors: [...errors, err.message] },
      { status: 500 }
    );
  }
}

export const GET = handler;
export const POST = handler;
