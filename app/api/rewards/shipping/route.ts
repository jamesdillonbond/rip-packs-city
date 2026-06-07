// app/api/rewards/shipping/route.ts
//
// POST { redemptionId, address }  — attach a shipping address to a MERCH
//      redemption the user owns (so the admin console can ship it).
// POST { redemptionId, giftTo }   — set / correct the Top Shot username a
//      MOMENT redemption should be gifted to (overrides the auto-resolved one).
//
// SECURITY: the user id is session-resolved (requireUser → auth.uid()). The
// update is scoped to redemptions owned by this user, of the right item type
// for the field being written (address→merch, giftTo→moment), and only while
// the redemption is still 'pending' — a user can never write fulfillment
// details onto someone else's redemption, onto the wrong good, or onto an
// already-shipped one.

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

// A Top Shot username: drop a leading "@", strip control characters (charcode
// < 32 or 127), trim, cap at 40. Returns null when nothing usable is left.
function sanitizeGiftTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = Array.from(raw.replace(/^@+/, ""))
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim()
    .slice(0, 40);
  return stripped.length > 0 ? stripped : null;
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { redemptionId?: unknown; address?: unknown; giftTo?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const redemptionId = Number(body?.redemptionId);
  if (!Number.isInteger(redemptionId)) {
    return NextResponse.json({ error: "bad_redemption" }, { status: 400 });
  }

  // Exactly one of address (merch) or giftTo (moment).
  const wantsGift = body?.giftTo !== undefined && body?.giftTo !== null;
  const wantsAddress = body?.address !== undefined && body?.address !== null;
  if (wantsGift === wantsAddress) {
    return NextResponse.json({ error: "provide_address_or_giftTo" }, { status: 400 });
  }

  const address = wantsAddress ? sanitizeAddress(body?.address) : null;
  const giftTo = wantsGift ? sanitizeGiftTo(body?.giftTo) : null;
  if (wantsAddress && !address) {
    return NextResponse.json({ error: "bad_address" }, { status: 400 });
  }
  if (wantsGift && !giftTo) {
    return NextResponse.json({ error: "bad_giftTo" }, { status: 400 });
  }

  // Confirm the redemption is this user's, still pending, and of the type that
  // the field being written is valid for.
  const { data: red, error: readErr } = await (supabase as any)
    .from("redemptions")
    .select("id, user_id, status, fulfillment, shop_items!inner(type)")
    .eq("id", redemptionId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (!red) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (red.status !== "pending") {
    return NextResponse.json({ error: "not_pending" }, { status: 400 });
  }

  const itemType = red.shop_items?.type;
  if (wantsAddress && itemType !== "merch") {
    return NextResponse.json({ error: "not_shippable" }, { status: 400 });
  }
  if (wantsGift && itemType !== "moment") {
    return NextResponse.json({ error: "not_giftable" }, { status: 400 });
  }

  const fulfillment = {
    ...(red.fulfillment && typeof red.fulfillment === "object" ? red.fulfillment : {}),
    ...(wantsAddress ? { ship_to: address } : {}),
    ...(wantsGift ? { gift_to: giftTo } : {}),
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
