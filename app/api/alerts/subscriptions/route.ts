// app/api/alerts/subscriptions/route.ts
//
// Session-authed CRUD for channel-agnostic deal-feed subscriptions
// (alert_subscriptions). owner_key is ALWAYS the session user id — never a
// body field. The subscription body carries only filter prefs + delivery
// channels + cadence.
//
//   GET    -> this user's subscriptions, each enriched with a live
//             build_deal_alerts_for_subscription() preview count.
//   POST   -> create (no id) or update (id, scoped to owner_key).
//   PATCH  -> toggle active by id.
//   DELETE -> delete by ?id= (scoped to owner_key).

export const maxDuration = 15;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import {
  buildDealAlertsForSubscription,
  CHANNELS,
  type Channel,
} from "@/lib/alerts";

const CADENCES = ["instant", "daily", "weekly"] as const;

// Coerce a raw body into a validated, owner-scoped column set. Returns null +
// an error string on invalid input. Never reads owner_key from the body.
function sanitize(body: any): { row: Record<string, unknown> } | { error: string } {
  const channels = Array.isArray(body.channels)
    ? body.channels.filter((c: unknown): c is Channel => (CHANNELS as string[]).includes(c as string))
    : ["email"];
  if (channels.length === 0) return { error: "At least one delivery channel is required" };

  const cadence = CADENCES.includes(body.cadence) ? body.cadence : "instant";

  const numOrNull = (v: unknown, { min = 0 }: { min?: number } = {}): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return null;
    return n;
  };
  const intOrNull = (v: unknown): number | null => {
    const n = numOrNull(v);
    return n === null ? null : Math.round(n);
  };
  const arrOrNull = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null;
    const cleaned = v.map((x) => String(x).trim()).filter(Boolean);
    return cleaned.length ? cleaned : null;
  };
  const uuidArrOrNull = (v: unknown): string[] | null => {
    const a = arrOrNull(v);
    if (!a) return null;
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const cleaned = a.filter((x) => re.test(x));
    return cleaned.length ? cleaned : null;
  };
  const boolDefault = (v: unknown): boolean => v === true;

  const minDiscount = numOrNull(body.min_discount);

  const row: Record<string, unknown> = {
    label: typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 120) : "My deal alert",
    channels,
    cadence,
    collection_ids: uuidArrOrNull(body.collection_ids), // null = all active
    min_discount: minDiscount === null ? 25 : minDiscount,
    max_price: numOrNull(body.max_price),
    min_price: numOrNull(body.min_price),
    tiers: arrOrNull(body.tiers),
    player_names: arrOrNull(body.player_names),
    set_names: arrOrNull(body.set_names),
    team_names: arrOrNull(body.team_names),
    min_serial: intOrNull(body.min_serial),
    max_serial: intOrNull(body.max_serial),
    require_jersey_serial: boolDefault(body.require_jersey_serial),
    require_last_mint: boolDefault(body.require_last_mint),
    require_never_sold: boolDefault(body.require_never_sold),
    require_low_ask: boolDefault(body.require_low_ask),
    badges: arrOrNull(body.badges),
    active: body.active === undefined ? true : body.active === true,
  };
  return { row };
}

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data, error } = await supabase
    .from("alert_subscriptions")
    .select("*")
    .eq("owner_key", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[alerts/subscriptions GET]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich each with a live preview count (best-effort; never block the list).
  const subscriptions = await Promise.all(
    (data ?? []).map(async (sub: any) => {
      const preview = await buildDealAlertsForSubscription(sub.id);
      return {
        ...sub,
        preview_count: preview?.deals_count ?? null,
        preview_deals: Array.isArray(preview?.deals) ? preview!.deals.slice(0, 5) : [],
      };
    })
  );

  return NextResponse.json({ subscriptions });
}

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

  const result = sanitize(body);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const row = result.row;

  try {
    if (body.id) {
      // Update — scoped to owner_key so a user can't edit another's sub.
      const { data, error } = await supabase
        .from("alert_subscriptions")
        .update({ ...row, updated_at: new Date().toISOString() })
        .eq("id", body.id)
        .eq("owner_key", user.id)
        .select()
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
      const preview = await buildDealAlertsForSubscription(data.id);
      return NextResponse.json({ subscription: { ...data, preview_count: preview?.deals_count ?? null } });
    }

    const { data, error } = await supabase
      .from("alert_subscriptions")
      .insert({ ...row, owner_key: user.id })
      .select()
      .single();
    if (error) throw new Error(error.message);
    const preview = await buildDealAlertsForSubscription(data.id);
    return NextResponse.json(
      { subscription: { ...data, preview_count: preview?.deals_count ?? null } },
      { status: 201 }
    );
  } catch (err: any) {
    console.error("[alerts/subscriptions POST]", err?.message);
    return NextResponse.json({ error: err?.message ?? "Internal error" }, { status: 500 });
  }
}

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
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (typeof body.active !== "boolean") {
    return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("alert_subscriptions")
    .update({ active: body.active, updated_at: new Date().toISOString() })
    .eq("id", body.id)
    .eq("owner_key", user.id)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  return NextResponse.json({ subscription: data });
}

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
    .from("alert_subscriptions")
    .delete()
    .eq("id", id)
    .eq("owner_key", user.id)
    .select();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deleted: data.length });
}
