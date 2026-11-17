// app/api/rewards/redeem/route.ts
//
// POST { itemId } — redeem a shop item for the AUTHENTICATED user.
//
// SECURITY: the user id comes from the verified session (requireUser →
// auth.uid()), never from the request body. A client-supplied itemId is safe
// because redeem_shop_item() re-validates balance / stock / per-user limit /
// min_status / verified-wallet gate server-side. There is intentionally no
// endpoint that accepts a points amount.

import { NextRequest, NextResponse } from "next/server";
import { redeemItem } from "@/lib/rewards";
import { requireUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { itemId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const itemId = Number(body?.itemId);
  if (!Number.isInteger(itemId)) {
    return NextResponse.json({ error: "bad_item" }, { status: 400 });
  }

  const result = await redeemItem(user.id, itemId);
  return NextResponse.json(result, { status: result?.redeemed ? 200 : 400 });
}
