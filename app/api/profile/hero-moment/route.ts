// app/api/profile/hero-moment/route.ts
//
// Returns the single highest-FMV moment across all of the current user's
// saved wallets. Powers the Hero Holo Moment card on /profile.
//
// Reads from wallet_moments_cache (the table the wallet-search fanout +
// Pinnacle/UFC indexers populate) — NOT the `moments` table, which is
// only fed by the listings/sales ingest pipeline and is empty for
// background-indexed wallets.

import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { COLLECTIONS } from "@/lib/collections";

export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const { data: wallets } = await supabase
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id);

  if (!wallets || wallets.length === 0) {
    return NextResponse.json({ hero: null, reason: "no_wallets" });
  }

  const addresses = Array.from(
    new Set(wallets.map((w: any) => String(w.wallet_addr).toLowerCase()))
  );

  // Prefer a fully-hydrated moment over a higher-FMV but incomplete one.
  // Without this, a top-FMV row with null player_name / image_url renders
  // the HeroMomentCard with "Unknown" and a blank image. Pull the top
  // several rows ordered by FMV desc, then pick the first one that has
  // both player_name and image_url; if none are hydrated, fall back to
  // the raw top-FMV row so the card can render its graceful fallback.
  const { data: candidates, error } = await supabase
    .from("wallet_moments_cache")
    .select(
      "moment_id, edition_key, collection_id, player_name, set_name, tier, serial_number, image_url, fmv_usd, wallet_address"
    )
    .in("wallet_address", addresses)
    .order("fmv_usd", { ascending: false, nullsFirst: false })
    .limit(25);

  const top =
    (candidates ?? []).find((r: any) => r.player_name && r.image_url) ??
    (candidates ?? [])[0] ??
    null;

  if (error) {
    console.error("[hero-moment]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!top) {
    return NextResponse.json({ hero: null, reason: "no_moments" });
  }

  const fmv = Number(top.fmv_usd);
  if (!top.fmv_usd || !Number.isFinite(fmv) || fmv <= 0) {
    return NextResponse.json({ hero: null, reason: "no_fmv" });
  }

  const coll = COLLECTIONS.find((c) => c.supabaseCollectionId === top.collection_id);

  return NextResponse.json({
    hero: {
      momentId: top.moment_id,
      playerName: top.player_name,
      setName: top.set_name,
      tier: top.tier,
      serialNumber: top.serial_number,
      imageUrl: top.image_url,
      editionKey: top.edition_key,
      fmvUsd: fmv,
      collectionId: coll?.id ?? null,
      collectionLabel: coll?.label ?? null,
      collectionAccent: coll?.accent ?? null,
    },
  });
}
