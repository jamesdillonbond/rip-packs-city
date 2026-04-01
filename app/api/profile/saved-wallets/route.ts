import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET ?ownerKey=xxx
export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  try {
    const { data, error } = await supabase
      .from("saved_wallets")
      .select("*")
      .eq("owner_key", ownerKey);

    if (error) {
      console.error("[saved-wallets GET]", error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Normalize DB column names to client-expected shape
    const wallets = (data ?? []).map(function(row: any) {
      return {
        ...row,
        wallet_addr: row.wallet_address ?? row.wallet_addr,
        display_name: row.nickname ?? row.display_name ?? null,
        cached_fmv: row.cached_fmv_usd ?? row.cached_fmv ?? null,
        pinned_at: row.created_at ?? row.pinned_at ?? new Date().toISOString(),
      };
    });
    return NextResponse.json({ wallets });
  } catch (err: any) {
    console.error("[saved-wallets GET] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// POST { ownerKey, walletAddr, username, displayName, accentColor }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, walletAddr, username, displayName, accentColor } = body;
  if (!ownerKey || !walletAddr) {
    return NextResponse.json({ error: "ownerKey and walletAddr required" }, { status: 400 });
  }

  try {
    const { data, error } = await supabase
      .from("saved_wallets")
      .upsert({
        owner_key: ownerKey,
        wallet_address: walletAddr,
        username: username ?? null,
        nickname: displayName ?? null,
        accent_color: accentColor ?? "#E03A2F",
      }, { onConflict: "owner_key,wallet_address" })
      .select()
      .single();

    if (error) {
      console.error("[saved-wallets POST]", error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ wallet: data });
  } catch (err: any) {
    console.error("[saved-wallets POST] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// DELETE { ownerKey, walletAddr }
export async function DELETE(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, walletAddr } = body;
  if (!ownerKey || !walletAddr) {
    return NextResponse.json({ error: "ownerKey and walletAddr required" }, { status: 400 });
  }

  try {
    const { error } = await supabase
      .from("saved_wallets")
      .delete()
      .eq("owner_key", ownerKey)
      .eq("wallet_address", walletAddr);

    if (error) {
      console.error("[saved-wallets DELETE]", error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[saved-wallets DELETE] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// PATCH { ownerKey, walletAddr, cachedFmv, cachedMomentCount, cachedTopTier,
//         cachedChange24h, cachedBadges, cachedRpcScore }
// Updates cached stats and fires portfolio snapshot write.
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
    cachedRpcScore,
  } = body;

  if (!ownerKey || !walletAddr) {
    return NextResponse.json({ error: "ownerKey and walletAddr required" }, { status: 400 });
  }

  try {
    const updatePayload: Record<string, unknown> = {
      cached_fmv_usd: cachedFmv ?? null,
      cached_moment_count: cachedMomentCount ?? null,
      cached_top_tier: cachedTopTier ?? null,
      cached_change_24h: cachedChange24h ?? null,
      cached_badges: cachedBadges ?? null,
      cache_updated_at: new Date().toISOString(),
      last_viewed: new Date().toISOString(),
    };

    // Only write rpc_score if we got a real value
    if (typeof cachedRpcScore === "number" && cachedRpcScore > 0) {
      updatePayload.cached_rpc_score = cachedRpcScore;
    }

    const { data, error } = await supabase
      .from("saved_wallets")
      .update(updatePayload)
      .eq("owner_key", ownerKey)
      .eq("wallet_address", walletAddr)
      .select()
      .single();

    if (error) {
      console.error("[saved-wallets PATCH]", error.message, error.details, error.hint);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Fire-and-forget: aggregate all wallets and write a daily portfolio snapshot
    writePortfolioSnapshot(ownerKey).catch(function(err) {
      console.error("[portfolio-snapshot write]", err);
    });

    return NextResponse.json({ wallet: data });
  } catch (err: any) {
    console.error("[saved-wallets PATCH] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// Aggregates all saved wallets for the owner and upserts today's portfolio snapshot.
async function writePortfolioSnapshot(ownerKey: string) {
  const { data: wallets, error: walletsError } = await supabase
    .from("saved_wallets")
    .select("cached_fmv_usd, cached_moment_count, cached_rpc_score")
    .eq("owner_key", ownerKey);

  if (walletsError || !wallets) return;

  const totalFmv = wallets.reduce(function(sum: number, w: any) { return sum + (Number(w.cached_fmv_usd) || 0); }, 0);
  const momentCount = wallets.reduce(function(sum: number, w: any) { return sum + (Number(w.cached_moment_count) || 0); }, 0);
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
