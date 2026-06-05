// app/api/rewards/shipping/route.ts
//
// POST { redemptionId, address } — attach a shipping address to a merch
// redemption the user owns, so the admin console can fulfill it.
//
// SECURITY: the user id is session-resolved (requireUser → auth.uid()). The
// update is scoped to redemptions owned by this user AND of a shippable
// (type='merch') item, so a user can never write an address onto someone else's
// redemption or onto a non-physical good.
//
// NOTE: merch shop items are currently inactive (no SKU is redeemable), so this
// endpoint has no live producer yet. It's the server half of swag fulfillment —
// the redeem-time address modal + merch activation are intentionally deferred
// until there's demand. See docs handoff Item 5.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase-server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface ShipAddress {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
}

function sanitizeAddress(raw: unknown): ShipAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const clip = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 200) : undefined);
  const out: ShipAddress = {
    name: clip(a.name),
    line1: clip(a.line1),
    line2: clip(a.line2),
    city: clip(a.city),
    region: clip(a.region),
    postal: clip(a.postal),
    country: clip(a.country),
  };
  // Require at least a name + line1 + city to be a usable shipping address.
  if (!out.name || !out.line1 || !out.city) return null;
  return out;
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { redemptionId?: unknown; address?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const redemptionId = Number(body?.redemptionId);
  if (!Number.isInteger(redemptionId)) {
    return NextResponse.json({ error: "bad_redemption" }, { status: 400 });
  }
  const address = sanitizeAddress(body?.address);
  if (!address) {
    return NextResponse.json({ error: "bad_address" }, { status: 400 });
  }

  // Confirm the redemption is this user's and is a shippable merch item.
  const { data: red, error: readErr } = await (supabase as any)
    .from("redemptions")
    .select("id, user_id, shop_item_id, fulfillment, shop_items!inner(type)")
    .eq("id", redemptionId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!red) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (red.shop_items?.type !== "merch") {
    return NextResponse.json({ error: "not_shippable" }, { status: 400 });
  }

  const fulfillment = {
    ...(red.fulfillment && typeof red.fulfillment === "object" ? red.fulfillment : {}),
    ship_to: address,
  };

  const { error: upErr } = await (supabase as any)
    .from("redemptions")
    .update({ fulfillment, updated_at: new Date().toISOString() })
    .eq("id", redemptionId)
    .eq("user_id", user.id);
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
