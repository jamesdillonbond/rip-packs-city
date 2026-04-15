// app/api/profile/top-movers/route.ts
//
// GET /api/profile/top-movers?ownerKey=xxx&days=7
// For every saved wallet, calls the get_top_movers RPC and merges the
// gainers / losers across wallets, returning the top 5 of each by absolute
// dollar change.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

interface Mover {
  edition_id: string;
  player_name: string | null;
  set_name: string | null;
  current_fmv: number | null;
  past_fmv: number | null;
  delta: number;
  pct_change: number | null;
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  const days = Math.max(
    1,
    Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10) || 7, 90)
  );

  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  try {
    const { data: wallets, error: walletsError } = await supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("owner_key", ownerKey);

    if (walletsError) {
      console.error("[top-movers] wallets error:", walletsError.message);
      return NextResponse.json({ error: walletsError.message }, { status: 500 });
    }

    const allGainers: Mover[] = [];
    const allLosers: Mover[] = [];

    for (const w of (wallets ?? []) as Array<{ wallet_addr: string }>) {
      const addr = w.wallet_addr?.startsWith("0x")
        ? w.wallet_addr
        : "0x" + (w.wallet_addr ?? "");
      if (!addr || addr === "0x") continue;

      const { data, error } = await (supabase as any).rpc("get_top_movers", {
        p_wallet: addr,
        p_days: days,
      });
      if (error) {
        console.error("[top-movers] rpc error:", error.message);
        continue;
      }
      const payload = (data ?? {}) as { gainers?: Mover[]; losers?: Mover[] };
      if (Array.isArray(payload.gainers)) allGainers.push(...payload.gainers);
      if (Array.isArray(payload.losers)) allLosers.push(...payload.losers);
    }

    // Dedupe by edition_id (keep first appearance) then re-sort across wallets
    function dedupe(rows: Mover[]): Mover[] {
      const seen = new Set<string>();
      const out: Mover[] = [];
      for (const r of rows) {
        if (!r.edition_id || seen.has(r.edition_id)) continue;
        seen.add(r.edition_id);
        out.push(r);
      }
      return out;
    }

    const gainers = dedupe(allGainers)
      .sort(function (a, b) { return Number(b.delta) - Number(a.delta); })
      .slice(0, 5);
    const losers = dedupe(allLosers)
      .sort(function (a, b) { return Number(a.delta) - Number(b.delta); })
      .slice(0, 5);

    return NextResponse.json({ gainers, losers });
  } catch (err: any) {
    console.error("[top-movers] unexpected:", err?.message);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
