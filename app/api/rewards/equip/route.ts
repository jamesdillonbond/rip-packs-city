// app/api/rewards/equip/route.ts
//
// POST { sku } — equip a cosmetic the user already OWNS into its slot.
//
// SECURITY: the user id is session-resolved (requireUser → auth.uid()), never
// from the body. The client names a sku, but ownership is re-verified against
// user_cosmetics server-side, and the slot/value applied come from the OWNED
// row — never from the client. A user can only equip what they've redeemed.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/supabase-server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { sku?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sku = String(body?.sku ?? "");
  if (!sku) {
    return NextResponse.json({ error: "bad_sku" }, { status: 400 });
  }

  // Must own the cosmetic. slot + value are read from the owned row, not trusted
  // from the request.
  const { data: owned, error } = await (supabase as any)
    .from("user_cosmetics")
    .select("slot, value")
    .eq("user_id", user.id)
    .eq("sku", sku)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!owned) {
    return NextResponse.json({ error: "not_owned" }, { status: 403 });
  }

  const slot = String(owned.slot ?? "");
  const value = (owned.value as string | null) ?? null;
  const col =
    slot === "border" ? "equipped_border" : slot === "banner" ? "equipped_banner" : null;
  if (!col) {
    return NextResponse.json({ error: "unequippable_slot" }, { status: 400 });
  }

  // Upsert (PK is user_id) so equipping works even before a profile_bio row
  // exists for this user.
  const { error: upErr } = await (supabase as any)
    .from("profile_bio")
    .upsert(
      { user_id: user.id, [col]: value, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, slot, value });
}
