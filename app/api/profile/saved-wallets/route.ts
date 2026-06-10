// app/api/profile/saved-wallets/route.ts
//
// Phase 4: auth.uid()-keyed saved wallets with per-collection scoping.
// Every wallet belongs to a specific collection (defaults to NBA Top Shot
// when callers omit collectionId). Users can pin the same address under
// multiple collections.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { checkFeatureQuota } from "@/lib/pro-tier";
import { publishedCollections } from "@/lib/collections";

const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

// Self-heal for users who got approved via the allow-list but bounced before
// the save-wallet step: their dashboard keys off zero saved_wallets rows and
// renders empty. When a user has NO saved wallets at ALL, attach the wallet
// from their active allow_list row — one row per published collection, since a
// Dapper wallet is the same address across every collection. Guarded on
// zero-rows-EVER (authoritative, unfiltered): a user who deliberately deleted
// their wallets also has zero rows, which is an acceptable re-seed at current
// scale. Returns the freshly-attached rows, or [] when nothing was attached.
async function maybeAutoAttachAllowListWallet(user: {
  id: string;
  email?: string | null;
}): Promise<any[]> {
  const email = user.email?.trim().toLowerCase();
  if (!email) return [];

  // Authoritative zero-rows-EVER guard — independent of any collectionId
  // filter the caller applied, so we don't re-seed a user who simply has no
  // wallet under one specific collection.
  const { count: totalRows } = await supabase
    .from("saved_wallets")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if ((totalRows ?? 0) > 0) return [];

  // Service-role read of the allow_list row (this client IS supabaseAdmin).
  const { data: alRow, error: alErr } = await supabase
    .from("allow_list")
    .select("wallet_addr, username")
    .eq("status", "active")
    .eq("email", email)
    .maybeSingle();
  if (alErr || !alRow) return [];

  const walletAddr =
    typeof alRow.wallet_addr === "string"
      ? alRow.wallet_addr.trim().toLowerCase()
      : "";
  if (!walletAddr) return [];

  const username = typeof alRow.username === "string" ? alRow.username : null;
  const rows = publishedCollections()
    .map((c) => c.supabaseCollectionId)
    .filter((id): id is string => Boolean(id))
    .map((collectionId) => ({
      user_id: user.id,
      wallet_addr: walletAddr,
      collection_id: collectionId,
      username,
      accent_color: "#E03A2F",
      // verified_at intentionally left NULL — verification stays with the
      // separate listing-challenge flow.
    }));
  if (rows.length === 0) return [];

  const { data: upserted, error: upErr } = await supabase
    .from("saved_wallets")
    .upsert(rows, { onConflict: "user_id,wallet_addr,collection_id" })
    .select();
  if (upErr) {
    console.warn("[saved-wallets GET] auto-attach upsert error", upErr.message);
    return [];
  }
  return upserted ?? [];
}

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  // Optional ?collectionId=<uuid> filter so collection-aware pages can fetch
  // just their own saved wallet without loading (and iterating) the full set.
  const collectionIdFilter = req.nextUrl.searchParams.get("collectionId");

  try {
    let query = supabase
      .from("saved_wallets")
      .select("*")
      .eq("user_id", user.id);

    if (collectionIdFilter) {
      query = query.eq("collection_id", collectionIdFilter);
    }

    const { data, error } = await query.order("pinned_at", { ascending: false });

    if (error) {
      console.error("[saved-wallets GET]", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const mapRow = (row: any) => ({
      ...row,
      cached_fmv: row.cached_fmv_usd ?? row.cached_fmv ?? null,
      pinned_at: row.pinned_at ?? new Date().toISOString(),
    });

    let rawRows = data ?? [];

    // No saved wallets for this view — try the allow-list self-heal once. The
    // attach itself re-checks zero-rows-EVER (unfiltered), so this is a no-op
    // for users who already have wallets under other collections.
    if (rawRows.length === 0) {
      const attached = await maybeAutoAttachAllowListWallet(user);
      if (attached.length > 0) {
        rawRows = collectionIdFilter
          ? attached.filter((r: any) => r.collection_id === collectionIdFilter)
          : attached;
      }
    }

    const wallets = rawRows.map(mapRow);
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

  // Pro-tier saved-wallet cap. feature_quotas.saved_wallets_max stores a
  // count limit (not a daily-event limit) keyed on the user's wallet via
  // get_user_plan. Free → 1 wallet; pro_trial → 5; pro_paid/grandfather/
  // moments_payment → unlimited; founding/admin → unlimited.
  // Existence of the row IS the count, so we don't fire record_feature_usage
  // here. We pre-check on POST only; idempotent re-saves of the same
  // (user_id, wallet_addr, collection_id) skip the cap check below.
  try {
    const { count: existingForRow } = await supabase
      .from("saved_wallets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("wallet_addr", walletAddr)
      .eq("collection_id", resolvedCollectionId);

    const isReSave = (existingForRow ?? 0) > 0;
    if (!isReSave) {
      const { count: currentCount } = await supabase
        .from("saved_wallets")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);

      const quota = await checkFeatureQuota(walletAddr, "saved_wallets_max");
      const maxAllowed = quota.daily_limit; // null = unlimited per quota RPC contract
      if (maxAllowed !== null && (currentCount ?? 0) >= maxAllowed) {
        return NextResponse.json(
          {
            error: "plan_limit_reached",
            message: `Free plan supports ${maxAllowed} saved wallet${maxAllowed === 1 ? "" : "s"}. Upgrade to RPC Pro for unlimited.`,
            plan: quota.plan,
            saved_wallet_count: currentCount ?? 0,
            saved_wallet_limit: maxAllowed,
            upgrade_url: "/pricing",
          },
          { status: 402 }
        );
      }
    }
  } catch (err) {
    // Fail-open on quota infra errors so a transient Postgres hiccup doesn't
    // block legitimate saves. The count check is best-effort defense in
    // depth; the database itself remains the source of truth.
    console.warn("[saved-wallets POST] quota check error", err);
  }

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
