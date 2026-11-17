// app/api/rewards/equip/route.ts
//
// POST   { sku }  — equip a cosmetic the user already OWNS into its slot.
// DELETE { slot } — take it off again.
//
// SECURITY: the user id is session-resolved (requireUser → auth.uid()), never
// from the body. The client names a sku, but ownership is re-verified against
// user_cosmetics server-side, and the slot/value applied come from the OWNED
// row — never from the client. A user can only equip what they've redeemed.
//
// ⚠ UNTIL 2026-08-13 EQUIPPING WAS ONE-WAY. This route only ever WROTE a value,
// and no UI cleared one, so a collector who tried a border on could never take
// it off — the single most basic expectation of a cosmetic, and the reason
// trying one carried more risk than it should. DELETE closes it.
//
// The unequip path deliberately does NOT check ownership: it nulls a slot, and
// requiring someone to still own a cosmetic in order to REMOVE it would trap a
// collector whose entitlement was revoked wearing it forever. Equipping is the
// privileged direction; taking something off is not.

import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
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
    return apiErrorResponse(error, "api/rewards/equip");
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
    return apiErrorResponse(upErr, "api/rewards/equip");
  }

  return NextResponse.json({ ok: true, slot, value });
}

/** Slot name -> the profile_bio column it equips into. */
const SLOT_COLUMN: Record<string, "equipped_border" | "equipped_banner"> = {
  border: "equipped_border",
  banner: "equipped_banner",
};

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { slot?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Own-property lookup: `slot` is client-supplied, and a bare `MAP[slot]` read
  // matches inherited Object.prototype members, so "constructor" would resolve
  // to a truthy function and be spliced into the update as a column name.
  const slot = String(body?.slot ?? "");
  const col = Object.prototype.hasOwnProperty.call(SLOT_COLUMN, slot)
    ? SLOT_COLUMN[slot]
    : null;
  if (!col) {
    return NextResponse.json({ error: "unequippable_slot" }, { status: 400 });
  }

  // UPDATE, not upsert. Unequipping is meaningful only for a collector who
  // already has a profile_bio row; creating one to record the absence of a
  // cosmetic writes a row to say nothing.
  const { error } = await (supabase as any)
    .from("profile_bio")
    .update({ [col]: null, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);

  if (error) {
    return apiErrorResponse(error, "api/rewards/equip");
  }

  // Deliberately idempotent: taking off something you are not wearing is not an
  // error, and a 404 here would make the button fail for the collector who
  // double-clicked it.
  return NextResponse.json({ ok: true, slot, value: null });
}
