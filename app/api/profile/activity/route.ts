// app/api/profile/activity/route.ts
//
// Returns last 20 sales over the past 7 days for wallets in saved_wallets
// of users the current user follows. Used on /profile under "Friend Activity".

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

  // 1) Who do I follow?
  const { data: follows, error: fErr } = await supabase
    .from("follows")
    .select("followee_user_id")
    .eq("follower_user_id", user.id);
  if (fErr) {
    console.error("[activity follows]", fErr);
    return NextResponse.json({ error: fErr.message }, { status: 500 });
  }
  const followeeIds = (follows ?? []).map((f: any) => f.followee_user_id);
  if (followeeIds.length === 0) {
    return NextResponse.json({ activity: [] });
  }

  // 2) What wallets do they track? (with username for attribution)
  const [{ data: wallets }, { data: bios }] = await Promise.all([
    supabase
      .from("saved_wallets")
      .select("user_id, wallet_addr, collection_id")
      .in("user_id", followeeIds),
    supabase
      .from("profile_bio")
      .select("user_id, username, display_name")
      .in("user_id", followeeIds),
  ]);

  const walletRows = wallets ?? [];
  if (walletRows.length === 0) {
    return NextResponse.json({ activity: [] });
  }

  const bioMap = new Map<string, any>();
  (bios ?? []).forEach((b: any) => bioMap.set(b.user_id, b));

  const addresses = Array.from(
    new Set(walletRows.map((w: any) => String(w.wallet_addr).toLowerCase()))
  );

  // 3) Pull sales in the last 7 days where seller or buyer matches those wallets.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // sales_2026 is the current partition; that's what we want for "last 7 days"
  const { data: sales, error: sErr } = await supabase
    .from("sales_2026")
    .select("sold_at, price_usd, collection_id, edition_id, moment_id, seller_address, buyer_address, serial_number")
    .gte("sold_at", sevenDaysAgo)
    .or(
      `seller_address.in.(${addresses.join(",")}),buyer_address.in.(${addresses.join(",")})`
    )
    .order("sold_at", { ascending: false })
    .limit(60);

  if (sErr) {
    console.error("[activity sales]", sErr);
    return NextResponse.json({ error: sErr.message }, { status: 500 });
  }

  const salesRows = sales ?? [];
  if (salesRows.length === 0) {
    return NextResponse.json({ activity: [] });
  }

  // 4) Enrich with edition display fields
  const editionIds = Array.from(new Set(salesRows.map((s: any) => s.edition_id).filter(Boolean)));
  const { data: editions } = editionIds.length
    ? await supabase
        .from("editions")
        .select("id, player_name, set_name, tier, thumbnail_url")
        .in("id", editionIds)
    : { data: [] as any[] };

  const editionMap = new Map<string, any>();
  (editions ?? []).forEach((e: any) => editionMap.set(e.id, e));

  // Map address -> followee metadata (first match wins)
  const addressOwner = new Map<string, { user_id: string; collection_id: string }>();
  for (const w of walletRows) {
    const key = `${String(w.wallet_addr).toLowerCase()}|${w.collection_id}`;
    if (!addressOwner.has(key)) {
      addressOwner.set(key, { user_id: w.user_id, collection_id: w.collection_id });
    }
  }

  const items: any[] = [];
  for (const s of salesRows) {
    const matchKey = (addr: string) => `${String(addr).toLowerCase()}|${s.collection_id}`;
    const seller = s.seller_address ? addressOwner.get(matchKey(s.seller_address)) : null;
    const buyer = s.buyer_address ? addressOwner.get(matchKey(s.buyer_address)) : null;
    const owner = seller || buyer;
    if (!owner) continue;

    const bio = bioMap.get(owner.user_id);
    const edition = editionMap.get(s.edition_id);
    items.push({
      followee_username: bio?.username ?? null,
      followee_display_name: bio?.display_name ?? null,
      role: seller ? "seller" : "buyer",
      wallet_addr: seller ? s.seller_address : s.buyer_address,
      collection_id: s.collection_id,
      player_name: edition?.player_name ?? null,
      set_name: edition?.set_name ?? null,
      tier: edition?.tier ?? null,
      thumbnail_url: edition?.thumbnail_url ?? null,
      serial_number: s.serial_number ?? null,
      price_usd: s.price_usd ?? null,
      sold_at: s.sold_at,
    });
    if (items.length >= 20) break;
  }

  return NextResponse.json({ activity: items });
}
