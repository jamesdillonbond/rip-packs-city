// app/api/alerts/route.ts
//
// Session-authed per-edition FMV alerts ("watch this edition"). owner_key is
// ALWAYS the session user id — never a body field. Mirrors the security
// invariant of the deal-feed subscriptions route.
//
//   GET    -> this user's fmv_alerts, each enriched with live FMV + ask +
//             currently_triggered (best-effort preview).
//   POST   -> create or update an alert (upsert on owner+edition+type).
//   PATCH  -> toggle active by id.
//   DELETE -> delete by ?id= (scoped to owner_key).
//
// alert_type vocabulary matches dispatch_triggered_fmv_alerts (the cron that
// actually fires these): price_below | fmv_below | fmv_above | discount_above.

export const maxDuration = 10;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

const ALERT_TYPES = ["price_below", "fmv_below", "fmv_above", "discount_above"] as const;
type AlertType = (typeof ALERT_TYPES)[number];
// fmv_alerts.channel CHECK allows email | telegram | both. We surface email +
// telegram (the dispatcher resolves a verified notification_channels row for the
// channel, falling back to notification_email for email).
const CHANNELS = ["email", "telegram"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TS_COLLECTION = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

// ── Live market data for the preview ──────────────────────────────────────────
// FMV legs (fmv_below/fmv_above) read the same latest-per-edition fmv_snapshots
// the dispatcher uses, so they're exact. Ask legs (price_below/discount_above)
// use badge_editions.low_ask as a best-effort indicator — the authoritative
// trigger is the cron, which reads cached_listings.
async function fetchMarketData(
  alerts: Array<{ edition_key: string; collection_id: string | null }>
) {
  const fmvByKey = new Map<string, number>();
  const askByKey = new Map<string, number>();
  if (!alerts.length) return { fmvByKey, askByKey };

  const key = (collectionId: string | null, ext: string) => `${collectionId ?? TS_COLLECTION}:${ext}`;
  const editionKeys = [...new Set(alerts.map((a) => a.edition_key))];

  // Resolve edition internal ids (scoped to the collections in play).
  const collectionIds = [...new Set(alerts.map((a) => a.collection_id ?? TS_COLLECTION))];
  const { data: editionRows } = await supabase
    .from("editions")
    .select("id, external_id, collection_id")
    .in("external_id", editionKeys)
    .in("collection_id", collectionIds);

  const idToKey = new Map<string, string>();
  const internalIds: string[] = [];
  for (const row of editionRows ?? []) {
    idToKey.set(row.id, key(row.collection_id, row.external_id));
    internalIds.push(row.id);
  }

  if (internalIds.length) {
    const { data: fmvRows } = await supabase
      .from("fmv_snapshots")
      .select("edition_id, fmv_usd, computed_at")
      .in("edition_id", internalIds)
      .order("computed_at", { ascending: false });
    for (const row of fmvRows ?? []) {
      const k = idToKey.get(row.edition_id);
      if (k && !fmvByKey.has(k) && row.fmv_usd != null) fmvByKey.set(k, Number(row.fmv_usd));
    }
  }

  // badge_editions.low_ask is Top Shot keyed by external_id; only meaningful for
  // TS alerts. Map back onto each alert's collection-scoped key.
  const { data: badgeRows } = await supabase
    .from("badge_editions")
    .select("edition_key, low_ask")
    .in("edition_key", editionKeys);
  const lowAskByExt = new Map<string, number>();
  for (const row of badgeRows ?? []) {
    if (row.low_ask == null) continue;
    const prev = lowAskByExt.get(row.edition_key);
    if (prev == null || row.low_ask < prev) lowAskByExt.set(row.edition_key, Number(row.low_ask));
  }
  for (const a of alerts) {
    const ask = lowAskByExt.get(a.edition_key);
    if (ask != null) askByKey.set(key(a.collection_id, a.edition_key), ask);
  }

  return { fmvByKey, askByKey };
}

function evalTriggered(alertType: string, threshold: number, fmv: number | null, ask: number | null): boolean {
  switch (alertType) {
    case "price_below":
      return ask != null && ask <= threshold;
    case "fmv_below":
      return fmv != null && fmv <= threshold;
    case "fmv_above":
      return fmv != null && fmv >= threshold;
    case "discount_above":
      return ask != null && fmv != null && fmv > 0 && (1 - ask / fmv) * 100 >= threshold;
    default:
      return false;
  }
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const includeInactive = req.nextUrl.searchParams.get("include_inactive");
  try {
    let q = supabase
      .from("fmv_alerts")
      .select("*")
      .eq("owner_key", user.id)
      .order("created_at", { ascending: false });
    if (!includeInactive || includeInactive === "0" || includeInactive === "false") {
      q = q.eq("active", true);
    }
    const { data: alerts, error } = await q;
    if (error) throw new Error(error.message);
    if (!alerts || alerts.length === 0) return NextResponse.json([]);

    const { fmvByKey, askByKey } = await fetchMarketData(alerts);
    const enriched = alerts.map((alert: any) => {
      const k = `${alert.collection_id ?? TS_COLLECTION}:${alert.edition_key}`;
      const fmv = fmvByKey.get(k) ?? null;
      const ask = askByKey.get(k) ?? null;
      const current_discount_pct =
        fmv != null && ask != null && fmv > 0 ? Math.round(((fmv - ask) / fmv) * 100) : null;
      return {
        ...alert,
        fmv,
        low_ask: ask,
        current_discount_pct,
        currently_triggered: evalTriggered(alert.alert_type, Number(alert.threshold), fmv, ask),
      };
    });
    return NextResponse.json(enriched);
  } catch (err: any) {
    console.error("[alerts GET]", err?.message);
    return NextResponse.json({ error: err?.message ?? "Internal error" }, { status: 500 });
  }
}

// ── POST (create / update) ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { edition_key, player_name, set_name, alert_type, threshold, channel, notification_email, collection_id } = body;

  if (!edition_key || typeof edition_key !== "string") {
    return NextResponse.json({ error: "edition_key is required" }, { status: 400 });
  }
  if (!ALERT_TYPES.includes(alert_type)) {
    return NextResponse.json({ error: `alert_type must be one of ${ALERT_TYPES.join(", ")}` }, { status: 400 });
  }
  const thr = Number(threshold);
  if (!Number.isFinite(thr) || thr <= 0) {
    return NextResponse.json({ error: "threshold must be a positive number" }, { status: 400 });
  }
  const ch = CHANNELS.includes(channel) ? channel : "email";
  const collId = typeof collection_id === "string" && UUID_RE.test(collection_id) ? collection_id : TS_COLLECTION;

  // Email channel needs a delivery target: an explicit address, else the
  // session email. The dispatcher also accepts a linked verified email channel.
  let email: string | null = null;
  if (ch === "email") {
    const cand = typeof notification_email === "string" && EMAIL_RE.test(notification_email) ? notification_email : user.email;
    email = cand && EMAIL_RE.test(cand) ? cand : null;
  }

  try {
    const { data, error } = await supabase
      .from("fmv_alerts")
      .upsert(
        {
          owner_key: user.id, // session-resolved, never from the body
          edition_key,
          collection_id: collId,
          player_name: typeof player_name === "string" ? player_name : null,
          set_name: typeof set_name === "string" ? set_name : null,
          alert_type: alert_type as AlertType,
          threshold: thr,
          channel: ch,
          notification_email: email,
          active: true,
        },
        { onConflict: "owner_key,edition_key,alert_type" }
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json(data, { status: 201 });
  } catch (err: any) {
    console.error("[alerts POST]", err?.message);
    return NextResponse.json({ error: err?.message ?? "Internal error" }, { status: 500 });
  }
}

// ── PATCH (toggle active) ─────────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.id == null) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("fmv_alerts")
    .update({ active: body.active })
    .eq("id", body.id)
    .eq("owner_key", user.id)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  return NextResponse.json(data);
}

// ── DELETE (by id) ────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 });

  const { data, error } = await supabase
    .from("fmv_alerts")
    .delete()
    .eq("id", id)
    .eq("owner_key", user.id)
    .select();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Alert not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: data.length });
}
