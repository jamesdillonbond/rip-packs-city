import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

// GET ?ownerKey=xxx&days=30    → user-authored portfolio_snapshots (legacy)
// GET ?wallet=0x...&days=30    → per-wallet daily FMV derived from fmv_snapshots
//                                via get_wallet_fmv_history RPC (time-series card)
export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  const wallet = req.nextUrl.searchParams.get("wallet");
  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "30", 10), 90);

  // Wallet-based branch: derive daily totals from fmv_snapshots history
  if (wallet) {
    const { data, error } = await (supabase as any).rpc("get_wallet_fmv_history", {
      p_wallet: wallet,
      p_days: days,
    });

    if (error) {
      console.error("[portfolio-history GET wallet]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ snapshots: data ?? [] });
  }

  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey or wallet required" }, { status: 400 });
  }

  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .select("snapshot_date, total_fmv, moment_count, wallet_count")
    .eq("owner_key", ownerKey)
    .gte("snapshot_date", since.toISOString().split("T")[0])
    .order("snapshot_date", { ascending: true });

  if (error) {
    console.error("[portfolio-history GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ snapshots: data ?? [] });
}

// POST { ownerKey, totalFmv, momentCount, walletCount }
// Upserts a snapshot for today — called from saved-wallets PATCH after wallet load
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ownerKey, totalFmv, momentCount, walletCount } = body;

  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  const today = new Date().toISOString().split("T")[0];

  const { data, error } = await supabase
    .from("portfolio_snapshots")
    .upsert({
      owner_key: ownerKey,
      snapshot_date: today,
      total_fmv: totalFmv ?? 0,
      moment_count: momentCount ?? 0,
      wallet_count: walletCount ?? 0,
    }, { onConflict: "owner_key,snapshot_date" })
    .select()
    .single();

  if (error) {
    console.error("[portfolio-history POST]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ snapshot: data });
}