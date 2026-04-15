// app/api/alerts/route.ts
// GET    /api/alerts?owner_key=X[&include_inactive=1] — fetch alerts with live FMV/low_ask data
// POST   /api/alerts — upsert an alert
// PATCH  /api/alerts — toggle active state by id
// DELETE /api/alerts — deactivate alert(s) by edition_key (body) OR by id (query)

export const maxDuration = 10;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Helper: fetch current FMV and low_ask for a set of edition_keys
async function fetchMarketData(editionKeys: string[]) {
  const fmvMap = new Map<string, number>();
  const lowAskMap = new Map<string, number>();

  if (!editionKeys.length) return { fmvMap, lowAskMap };

  // Resolve edition internal IDs
  const { data: editionRows } = await supabase
    .from("editions")
    .select("id, external_id")
    .in("external_id", editionKeys);

  const extToId = new Map<string, string>();
  for (const row of editionRows ?? []) {
    extToId.set(row.external_id, row.id);
  }

  // Fetch latest FMV snapshots
  const internalIds = Array.from(extToId.values());
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

  // Fetch low_ask from badge_editions
  const { data: badgeRows } = await supabase
    .from("badge_editions")
    .select("edition_key, low_ask")
    .in("edition_key", editionKeys);

  for (const row of badgeRows ?? []) {
    if (row.low_ask != null) {
      const existing = lowAskMap.get(row.edition_key);
      if (existing == null || row.low_ask < existing) {
        lowAskMap.set(row.edition_key, row.low_ask);
      }
    }
  }

  return { fmvMap, lowAskMap };
}

export async function GET(req: NextRequest) {
  const owner_key = req.nextUrl.searchParams.get("owner_key");
  const include_inactive = req.nextUrl.searchParams.get("include_inactive");
  if (!owner_key) {
    return NextResponse.json({ error: "Missing required parameter: owner_key" }, { status: 400 });
  }

  try {
    let q = supabase
      .from("fmv_alerts")
      .select("*")
      .eq("owner_key", owner_key)
      .order("created_at", { ascending: false });
    if (!include_inactive || include_inactive === "0" || include_inactive === "false") {
      q = q.eq("active", true);
    }
    const { data: alerts, error } = await q;

    if (error) throw new Error(error.message);
    if (!alerts || alerts.length === 0) return NextResponse.json([]);

    // Fetch live market data for all edition_keys
    const editionKeys = [...new Set(alerts.map((a: any) => a.edition_key))] as string[];
    const { fmvMap, lowAskMap } = await fetchMarketData(editionKeys);

    // Enrich each alert with current market data and trigger status
    const enriched = alerts.map((alert: any) => {
      const fmv = fmvMap.get(alert.edition_key) ?? null;
      const low_ask = lowAskMap.get(alert.edition_key) ?? null;
      const current_discount_pct =
        fmv != null && low_ask != null && fmv > 0
          ? Math.round(((fmv - low_ask) / fmv) * 100)
          : null;

      // Evaluate if the alert condition is currently met
      let currently_triggered = false;
      if (fmv != null && low_ask != null) {
        if (alert.alert_type === "below_fmv_pct") {
          currently_triggered = ((fmv - low_ask) / fmv) * 100 >= alert.threshold;
        } else if (alert.alert_type === "below_price") {
          currently_triggered = low_ask <= alert.threshold;
        }
      }

      return { ...alert, fmv, low_ask, current_discount_pct, currently_triggered };
    });

    return NextResponse.json(enriched);
  } catch (err: any) {
    console.error("[alerts GET]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Simple email format validation
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { owner_key, edition_key, player_name, set_name, alert_type, threshold, channel, notification_email } = body;

    if (!owner_key) {
      return NextResponse.json({ error: "Missing required field: owner_key" }, { status: 400 });
    }
    if (!edition_key) {
      return NextResponse.json({ error: "Missing required field: edition_key" }, { status: 400 });
    }
    if (!alert_type || !["below_fmv_pct", "below_price"].includes(alert_type)) {
      return NextResponse.json({ error: "alert_type must be 'below_fmv_pct' or 'below_price'" }, { status: 400 });
    }
    if (threshold == null || typeof threshold !== "number" || threshold <= 0) {
      return NextResponse.json({ error: "threshold must be a positive number" }, { status: 400 });
    }
    if (!channel || !["email", "telegram", "both"].includes(channel)) {
      return NextResponse.json({ error: "channel must be 'email', 'telegram', or 'both'" }, { status: 400 });
    }
    // Require valid email when channel includes email delivery
    if ((channel === "email" || channel === "both") && (!notification_email || !EMAIL_RE.test(notification_email))) {
      return NextResponse.json({ error: "A valid notification_email is required when channel includes email" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("fmv_alerts")
      .upsert(
        {
          owner_key,
          edition_key,
          player_name: player_name ?? null,
          set_name: set_name ?? null,
          alert_type,
          threshold,
          channel,
          notification_email: notification_email ?? null,
          active: true,
        },
        { onConflict: "owner_key,edition_key,alert_type" }
      )
      .select()
      .single();

    if (error) throw new Error(error.message);

    return NextResponse.json(data, { status: 201 });
  } catch (err: any) {
    console.error("[alerts POST]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, owner_key, active } = body;

    if (!id) {
      return NextResponse.json({ error: "Missing required field: id" }, { status: 400 });
    }
    if (!owner_key) {
      return NextResponse.json({ error: "Missing required field: owner_key" }, { status: 400 });
    }
    if (typeof active !== "boolean") {
      return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("fmv_alerts")
      .update({ active })
      .eq("id", id)
      .eq("owner_key", owner_key)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: "Alert not found" }, { status: 404 });

    return NextResponse.json(data);
  } catch (err: any) {
    console.error("[alerts PATCH]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    // Support id-based deletion via query string: DELETE /api/alerts?id=X&owner_key=Y
    const qsId = req.nextUrl.searchParams.get("id");
    const qsOwner = req.nextUrl.searchParams.get("owner_key");
    if (qsId && qsOwner) {
      const { data, error } = await supabase
        .from("fmv_alerts")
        .delete()
        .eq("id", qsId)
        .eq("owner_key", qsOwner)
        .select();
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) {
        return NextResponse.json({ error: "Alert not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, deleted: data.length });
    }

    const body = await req.json();
    const { owner_key, edition_key, alert_type } = body;

    if (!owner_key) {
      return NextResponse.json({ error: "Missing required field: owner_key" }, { status: 400 });
    }
    if (!edition_key) {
      return NextResponse.json({ error: "Missing required field: edition_key" }, { status: 400 });
    }

    let query = supabase
      .from("fmv_alerts")
      .update({ active: false })
      .eq("owner_key", owner_key)
      .eq("edition_key", edition_key);

    // If alert_type provided, only deactivate that specific alert
    if (alert_type) {
      query = query.eq("alert_type", alert_type);
    }

    const { data, error } = await query.select();

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true, deactivated: data?.length ?? 0 });
  } catch (err: any) {
    console.error("[alerts DELETE]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
