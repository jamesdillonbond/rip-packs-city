// app/api/profile/saved-wallets/route.ts
//
// Phase 4: auth.uid()-keyed saved wallets with per-collection scoping.
// Every wallet belongs to a specific collection (defaults to NBA Top Shot
// when callers omit collectionId). Users can pin the same address under
// multiple collections.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  try {
    const { data, error } = await supabase
      .from("saved_wallets")
      .select("*")
      .eq("user_id", user.id)
      .order("pinned_at", { ascending: false });

    if (error) {
      console.error("[saved-wallets GET]", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const wallets = (data ?? []).map((row: any) => ({
      ...row,
      cached_fmv: row.cached_fmv_usd ?? row.cached_fmv ?? null,
      pinned_at: row.pinned_at ?? new Date().toISOString(),
    }));
    return NextResponse.json({ wallets });
  } catch (err: any) {
    console.error("[saved-wallets GET] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  let { walletAddr } = body;
  const { username, displayName, nickname, accentColor, collectionId } = body;
  if (!walletAddr) {
    return NextResponse.json({ error: "walletAddr required" }, { status: 400 });
  }
  walletAddr = String(walletAddr).toLowerCase();
  const resolvedCollectionId = collectionId ?? NBA_TOP_SHOT_UUID;

  try {
    const { data, error } = await supabase
      .from("saved_wallets")
      .upsert(
        {
          user_id: user.id,
          wallet_addr: walletAddr,
          collection_id: resolvedCollectionId,
          username: username ?? null,
          display_name: displayName ?? null,
          nickname: nickname ?? null,
          accent_color: accentColor ?? "#E03A2F",
        },
        { onConflict: "user_id,wallet_addr,collection_id" }
      )
      .select()
      .single();

    if (error) {
      console.error("[saved-wallets POST]", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ wallet: data });
  } catch (err: any) {
    console.error("[saved-wallets POST] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const body = await req.json();
  let { walletAddr } = body;
  const { collectionId } = body;
  if (!walletAddr) {
    return NextResponse.json({ error: "walletAddr required" }, { status: 400 });
  }
  walletAddr = String(walletAddr).toLowerCase();

  try {
    let query = supabase
      .from("saved_wallets")
      .delete()
      .eq("user_id", user.id)
      .eq("wallet_addr", walletAddr);

    if (collectionId) query = query.eq("collection_id", collectionId);

    const { error } = await query;
    if (error) {
      console.error("[saved-wallets DELETE]", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[saved-wallets DELETE] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
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

  let { walletAddr } = body;
  const {
    collectionId,
    cachedFmv,
    cachedMomentCount,
    cachedTopTier,
    cachedChange24h,
    cachedBadges,
    cachedRpcScore,
  } = body;

  if (!walletAddr || typeof walletAddr !== "string") {
    return NextResponse.json({ error: "walletAddr is required" }, { status: 400 });
  }
  walletAddr = walletAddr.toLowerCase();

  const updatePayload: Record<string, unknown> = {
    cached_fmv_usd: cachedFmv ?? null,
    cached_moment_count: cachedMomentCount ?? null,
    cached_top_tier: cachedTopTier ?? null,
    cached_change_24h: cachedChange24h ?? null,
    cached_badges: cachedBadges ?? null,
    cache_updated_at: new Date().toISOString(),
    last_viewed: new Date().toISOString(),
  };

  if (typeof cachedRpcScore === "number" && cachedRpcScore > 0) {
    updatePayload.cached_rpc_score = cachedRpcScore;
  }

  try {
    let query = supabase
      .from("saved_wallets")
      .update(updatePayload)
      .eq("user_id", user.id)
      .eq("wallet_addr", walletAddr);
    if (collectionId) query = query.eq("collection_id", collectionId);

    const { data, error } = await query.select();

    if (error) {
      console.error("[saved-wallets PATCH]", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    return NextResponse.json({ wallet: data[0] });
  } catch (err: any) {
    console.error("[saved-wallets PATCH] error:", err?.message);
    return NextResponse.json({ error: "Failed to update saved wallet" }, { status: 500 });
  }
}
