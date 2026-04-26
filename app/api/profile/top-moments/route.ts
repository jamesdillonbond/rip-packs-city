// app/api/profile/top-moments/route.ts
//
// Returns the top FMV-ranked moments owned across the current user's saved
// wallets. Backs the trophy-case "Pick from collection" picker modal so users
// can pin moments without bouncing through the collection page.
//
// Resolution order for the user_id:
//   1. ?ownerKey=<wallet_addr | username> query param (when supplied)
//   2. Authenticated session (requireUser fallback)

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

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
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 24);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 96
    ? Math.floor(limitRaw)
    : 24;

  const userId = await resolveUserId(ownerKey);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("get_user_top_owned_moments", {
    p_user_id: userId,
    p_limit: limit,
  });

  if (error) {
    console.error("[profile/top-moments]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ moments: data ?? [] });
}
