// app/api/profile/hero-moment/route.ts
//
// Returns the user's Hero Moment via the get_user_hero_moment RPC, which
// honors a manual override on profile_bio (hero_moment_id +
// hero_moment_collection_id) and otherwise falls back to the highest-FMV
// owned moment across the user's saved wallets.
//
// Resolution order for the user_id:
//   1. ?ownerKey=<wallet_addr | username> query param (when supplied)
//   2. Authenticated session (requireUser fallback)

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { COLLECTIONS } from "@/lib/collections";

async function resolveUserId(ownerKey: string | null): Promise<string | null> {
  if (ownerKey) {
    const key = ownerKey.trim();
    if (key.startsWith("0x")) {
      const { data } = await supabase
        .from("saved_wallets")
        .select("user_id")
        .eq("wallet_addr", key.toLowerCase())
        .limit(1)
        .maybeSingle();
      if (data?.user_id) return data.user_id as string;
    }
    const { data: bio } = await supabase
      .from("profile_bio")
      .select("user_id")
      .eq("username", key)
      .maybeSingle();
    if (bio?.user_id) return bio.user_id as string;
  }
  const user = await getCurrentUser();
  return user?.id ?? null;
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  const userId = await resolveUserId(ownerKey);
  if (!userId) {
    return NextResponse.json({ hero: null, reason: "no_user" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("get_user_hero_moment", {
    p_user_id: userId,
  });

  if (error) {
    console.error("[profile/hero-moment]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return NextResponse.json({ hero: null, reason: "no_moments" });
  }

  const fmv = Number(row.fmv_usd);
  if (!Number.isFinite(fmv) || fmv <= 0) {
    return NextResponse.json({
      hero: null,
      reason: row.is_manual_override ? "manual_no_fmv" : "no_fmv",
    });
  }

  const coll = COLLECTIONS.find((c) => c.supabaseCollectionId === row.collection_id);

  return NextResponse.json({
    hero: {
      momentId: row.moment_id,
      playerName: row.player_name,
      setName: row.set_name,
      tier: row.tier,
      serialNumber: row.serial_number,
      mintCount: row.mint_count,
      imageUrl: row.image_url,
      editionKey: row.edition_key,
      fmvUsd: fmv,
      isLocked: !!row.is_locked,
      isManualOverride: !!row.is_manual_override,
      collectionId: coll?.id ?? null,
      collectionUuid: row.collection_id ?? null,
      collectionLabel: coll?.label ?? null,
      collectionAccent: coll?.accent ?? null,
    },
  });
}
