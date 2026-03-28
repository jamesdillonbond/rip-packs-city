import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET ?ownerKey=xxx  → all saved wallets for this user
export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  const { data, error } = await supabase
    .from("saved_wallets")
    .select("*")
    .eq("owner_key", ownerKey)
    .order("pinned_at", { ascending: false });

  if (error) {
    console.error("[saved-wallets GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ wallets: data ?? [] });
}

// POST { ownerKey, walletAddr, username?, displayName?, accentColor? }  → add wallet
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, walletAddr, username, displayName, accentColor } = body;
  if (!ownerKey || !walletAddr) {
    return NextResponse.json({ error: "ownerKey and walletAddr required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("saved_wallets")
    .upsert({
      owner_key: ownerKey,
      wallet_addr: walletAddr,
      username: username ?? null,
      display_name: displayName ?? null,
      accent_color: accentColor ?? "#E03A2F",
      pinned_at: new Date().toISOString(),
    }, { onConflict: "owner_key,wallet_addr" })
    .select()
    .single();

  if (error) {
    console.error("[saved-wallets POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ wallet: data });
}

// DELETE { ownerKey, walletAddr }  → remove wallet
export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, walletAddr } = body;
  if (!ownerKey || !walletAddr) {
    return NextResponse.json({ error: "ownerKey and walletAddr required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("saved_wallets")
    .delete()
    .eq("owner_key", ownerKey)
    .eq("wallet_addr", walletAddr);

  if (error) {
    console.error("[saved-wallets DELETE]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// PATCH { ownerKey, walletAddr, cachedFmv, cachedMomentCount, cachedTopTier, cachedChange24h, cachedBadges }
// Called after wallet load to cache stats. Also writes a daily portfolio snapshot.
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const {
    ownerKey,
    walletAddr,
    cachedFmv,
    cachedMomentCount,
    cachedTopTier,
    cachedChange24h,
    cachedBadges,
  } = body;

  if (!ownerKey || !walletAddr) {
    return NextResponse.json({ error: "ownerKey and walletAddr required" }, { status: 400 });
  }

  // 1. Update the cached stats on this wallet row
  const { data, error } = await supabase
    .from("saved_wallets")
    .update({
      cached_fmv: cachedFmv ?? null,
      cached_moment_count: cachedMomentCount ?? null,
      cached_top_tier: cachedTopTier ?? null,
      cached_change_24h: cachedChange24h ?? null,
      cached_badges: cachedBadges ?? null,
      cache_updated_at: new Date().toISOString(),
      last_viewed: new Date().toISOString(),
    })
    .eq("owner_key", ownerKey)
    .eq("wallet_addr", walletAddr)
    .select()
    .single();

  if (error) {
    console.error("[saved-wallets PATCH]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2. Fire-and-forget: aggregate all saved wallets for this owner and write a daily snapshot
  // This builds the portfolio sparkline history without blocking the response.
  writePortfolioSnapshot(ownerKey).catch(function(err) {
    console.error("[portfolio-snapshot write]", err);
  });

  return NextResponse.json({ wallet: data });
}

// Aggregates all cached FMVs for the owner and upserts today's portfolio snapshot
async function writePortfolioSnapshot(ownerKey: string) {
  const { data: wallets, error: walletsError } = await supabase
    .from("saved_wallets")
    .select("cached_fmv, cached_moment_count")
    .eq("owner_key", ownerKey);

  if (walletsError || !wallets) return;

  const totalFmv = wallets.reduce(function(sum, w) { return sum + (Number(w.cached_fmv) || 0); }, 0);
  const momentCount = wallets.reduce(function(sum, w) { return sum + (Number(w.cached_moment_count) || 0); }, 0);
  const walletCount = wallets.length;
  const today = new Date().toISOString().split("T")[0];

  await supabase
    .from("portfolio_snapshots")
    .upsert({
      owner_key: ownerKey,
      snapshot_date: today,
      total_fmv: totalFmv,
      moment_count: momentCount,
      wallet_count: walletCount,
    }, { onConflict: "owner_key,snapshot_date" });
}