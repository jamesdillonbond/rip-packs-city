// app/api/profile/hero-moment/route.ts
//
// Returns the single highest-FMV moment across all of the current user's
// saved wallets. Powers the Hero Holo Moment card on /profile.

import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data: wallets } = await supabase
    .from("saved_wallets")
    .select("wallet_addr, collection_id")
    .eq("user_id", user.id);

  if (!wallets || wallets.length === 0) {
    return NextResponse.json({ hero: null, reason: "no_wallets" });
  }

  const addresses = Array.from(
    new Set(wallets.map((w: any) => String(w.wallet_addr).toLowerCase()))
  );

  // Pull candidate moments owned by the user's wallets
  const { data: moments, error } = await supabase
    .from("moments")
    .select("id, edition_id, collection_id, serial_number, nft_id, owner_address")
    .in("owner_address", addresses)
    .limit(500);

  if (error) {
    console.error("[hero-moment moments]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!moments || moments.length === 0) {
    return NextResponse.json({ hero: null, reason: "no_moments" });
  }

  // Pull latest FMV snapshot per edition
  const editionIds = Array.from(new Set(moments.map((m: any) => m.edition_id).filter(Boolean)));
  const { data: fmvRows } = editionIds.length
    ? await supabase
        .from("fmv_snapshots")
        .select("edition_id, fmv_usd, computed_at")
        .in("edition_id", editionIds)
        .order("computed_at", { ascending: false })
    : { data: [] as any[] };

  const fmvMap = new Map<string, number>();
  for (const row of fmvRows ?? []) {
    if (!fmvMap.has(row.edition_id)) {
      fmvMap.set(row.edition_id, Number(row.fmv_usd) || 0);
    }
  }

  // Pick the moment with highest FMV
  let bestMoment: any = null;
  let bestFmv = -1;
  for (const m of moments) {
    const f = fmvMap.get(m.edition_id) ?? 0;
    if (f > bestFmv) {
      bestFmv = f;
      bestMoment = m;
    }
  }

  if (!bestMoment || bestFmv <= 0) {
    return NextResponse.json({ hero: null, reason: "no_fmv_yet" });
  }

  const { data: edition } = await supabase
    .from("editions")
    .select("id, player_name, set_name, tier, thumbnail_url, video_url, circulation_count")
    .eq("id", bestMoment.edition_id)
    .maybeSingle();

  return NextResponse.json({
    hero: {
      moment_id: bestMoment.id,
      nft_id: bestMoment.nft_id,
      collection_id: bestMoment.collection_id,
      owner_address: bestMoment.owner_address,
      serial_number: bestMoment.serial_number,
      player_name: edition?.player_name ?? null,
      set_name: edition?.set_name ?? null,
      tier: edition?.tier ?? null,
      circulation_count: edition?.circulation_count ?? null,
      thumbnail_url: edition?.thumbnail_url ?? null,
      video_url: edition?.video_url ?? null,
      fmv_usd: bestFmv,
    },
  });
}
