// app/api/profile/tier-breakdown/route.ts
//
// GET /api/profile/tier-breakdown?ownerKey=xxx
// Aggregates wallet_moments_cache tier counts across every saved wallet for
// the owner. Uses the get_wallet_tier_counts RPC to bypass PostgREST's 1000
// row cap.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const TIER_ORDER = ["Common", "Fandom", "Rare", "Legendary", "Ultimate"];

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  try {
    const { data: wallets, error: walletsError } = await supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("owner_key", ownerKey);

    if (walletsError) {
      console.error("[tier-breakdown] wallets error:", walletsError.message);
      return NextResponse.json({ error: walletsError.message }, { status: 500 });
    }

    const aggregate: Record<string, number> = {};
    let total = 0;

    for (const w of (wallets ?? []) as Array<{ wallet_addr: string }>) {
      const addr = w.wallet_addr?.startsWith("0x")
        ? w.wallet_addr
        : "0x" + (w.wallet_addr ?? "");
      if (!addr || addr === "0x") continue;

      const { data, error } = await (supabase as any).rpc("get_wallet_tier_counts", {
        p_wallet: addr,
      });
      if (error) {
        console.error("[tier-breakdown] rpc error:", error.message);
        continue;
      }
      const counts: Record<string, number> = data ?? {};
      for (const [tier, n] of Object.entries(counts)) {
        const num = Number(n) || 0;
        aggregate[tier] = (aggregate[tier] ?? 0) + num;
        total += num;
      }
    }

    // Order by canonical tier order, then any unknown tiers
    const known = TIER_ORDER
      .filter(function (t) { return aggregate[t]; })
      .map(function (t) { return { tier: t, count: aggregate[t] }; });
    const extras = Object.entries(aggregate)
      .filter(function ([t]) { return !TIER_ORDER.includes(t); })
      .map(function ([t, n]) { return { tier: t, count: n }; });

    return NextResponse.json({ tiers: [...known, ...extras], total });
  } catch (err: any) {
    console.error("[tier-breakdown] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
