// app/api/profile/saved-wallets/route.ts
//
// Phase 4: auth.uid()-keyed saved wallets with per-collection scoping.
// Every wallet belongs to a specific collection (defaults to NBA Top Shot
// when callers omit collectionId). Users can pin the same address under
// multiple collections.

import { NextRequest, NextResponse, after } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { checkFeatureQuota } from "@/lib/pro-tier";
import { evaluateSavedWalletCap } from "@/lib/profile/saved-wallet-quota";
import { publishedCollections, getCollectionByUuid } from "@/lib/collections";
import { warmWalletDeep } from "@/lib/profile/warm-wallet";
// normalizeAddress, NOT `.toLowerCase()`. Base58 (Solana/Candy) is
// CASE-SENSITIVE, so lowercasing a pasted Candy address stores it mangled and it
// matches none of the 25,375 Candy rows already in wallet_moments_cache — the
// saved wallet then renders empty, which reads as "RPC has no Candy data" and is
// false. normalizeAddress lowercases Cadence/EVM and leaves base58 alone.
import { normalizeAddress, isValidAddressForChain } from "@/lib/address";

const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com")
  );
}

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
  // ⚠ THIS GUARD PROTECTS A WRITE, AND `?? 0` MADE IT FAIL OPEN INTO ONE.
  //
  // supabase-js RESOLVES on a query error, so a failed count comes back
  // `{ count: null, error }`. `(totalRows ?? 0) > 0` is then `false` — the guard
  // reads "this user has no wallets" — and the function falls through to the
  // `upsert` below. So a database hiccup could RE-SEED saved wallets for a user
  // who already has them, resetting `username` and `accent_color` on the
  // conflicting rows and restoring a wallet the user may have deleted on
  // purpose.
  //
  // ⚠ The comment above calls this the "authoritative zero-rows-EVER guard",
  // and it accepts re-seeding a deliberate deletion as "acceptable at current
  // scale" — but that acceptance was reasoned about a GENUINE zero, not about a
  // read that failed. CLAUDE.md's worst-shape note is about exactly this
  // direction: a surface that loads state and writes it back, where a failed
  // read becomes a mutation.
  //
  // The self-heal is best-effort, so "we could not tell" must mean DO NOTHING.
  const { count: totalRows, error: totalErr } = await supabase
    .from("saved_wallets")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (totalErr || typeof totalRows !== "number") {
    console.log(
      `[saved-wallets] auto-attach skipped — could not count existing wallets: ${
        totalErr?.message ?? "count was not a number"
      }`,
    );
    return [];
  }
  if (totalRows > 0) return [];

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
      ? normalizeAddress(alRow.wallet_addr)
      : "";
  if (!walletAddr) return [];

  const username = typeof alRow.username === "string" ? alRow.username : null;
  // ⚠ FLOW collections only. This self-heal takes a FLOW address off the
  // allow-list and fans it out per published collection; a Solana collection
  // (Candy MLB, published 2026-09-06) would receive a `0x…` row it can never
  // match — a "0 moments" tile manufactured by us. `published` is a NAV flag,
  // not a chain claim.
  const rows = publishedCollections()
    .filter((c) => c.dbChain === "flow")
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
      return apiErrorResponse(error, "api/profile/saved-wallets");
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
  walletAddr = normalizeAddress(String(walletAddr));
  const resolvedCollectionId = collectionId ?? NBA_TOP_SHOT_UUID;

  // Per-collection address-shape gate. `isValidAddressForChain` has existed in
  // lib/address.ts for a while but was wired NOWHERE on this path, so a Flow
  // address could be saved under Candy (and vice versa) — a row that can never
  // match a single wallet_moments_cache entry and renders as an empty
  // collection. Unmapped/unknown chains fall back to "any supported address",
  // so this can't block a legitimate wallet on a collection we haven't mapped.
  const targetCollection = getCollectionByUuid(resolvedCollectionId);
  if (targetCollection && !isValidAddressForChain(walletAddr, targetCollection.dbChain)) {
    return NextResponse.json(
      {
        error: "address_chain_mismatch",
        message: `That address isn't a valid ${targetCollection.label} wallet.`,
      },
      { status: 400 }
    );
  }

  // Pro-tier saved-wallet cap. feature_quotas.saved_wallets_max stores a
  // count limit (not a daily-event limit) keyed on the user's wallet via
  // get_user_plan. Free → 1 wallet; pro_trial → 5; pro_paid/grandfather/
  // moments_payment → unlimited; founding/admin → unlimited.
  // Existence of the row IS the count, so we don't fire record_feature_usage
  // here. We pre-check on POST only; idempotent re-saves of the same
  // (user_id, wallet_addr, collection_id) skip the cap check below.
  try {
    // Count DISTINCT wallet_addr, not rows. saved_wallets holds one row per
    // (wallet, collection), so a row count reads 5 after a single Dapper wallet
    // and blocked every free user (cap 1) on their SECOND collection.
    const { data: addrRows, error: addrErr } = await supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("user_id", user.id)
      .limit(1000);
    // DECISION (re-affirmed 2026-09-03): this cap check stays FAIL-OPEN — a
    // transient count failure must not block a collector's save, and the
    // downside is one extra free-plan wallet during an outage. But fail-open
    // and SILENT is a guard nobody can see fail: supabase-js RETURNS errors,
    // so `addrRows` is null and the count reads 0 with no trace. Bind the
    // error and log it at error level, so an outage that lets the cap slip
    // is at least measurable in the request log.
    if (addrErr) {
      console.error(
        "[saved-wallets POST] quota count read failed (cap check fails OPEN):",
        addrErr.message,
        "code:",
        (addrErr as { code?: string }).code ?? "unknown"
      );
    }

    const quota = await checkFeatureQuota(walletAddr, "saved_wallets_max");
    const maxAllowed = quota.daily_limit; // null = unlimited per quota RPC contract
    const { allowed, distinctCount } = evaluateSavedWalletCap(addrRows, walletAddr, maxAllowed);
    if (!allowed) {
      return NextResponse.json(
        {
          error: "plan_limit_reached",
          message: `Free plan supports ${maxAllowed} saved wallet${maxAllowed === 1 ? "" : "s"}. Upgrade to RPC Pro for unlimited.`,
          plan: quota.plan,
          saved_wallet_count: distinctCount,
          saved_wallet_limit: maxAllowed,
          upgrade_url: "/pricing",
        },
        { status: 402 }
      );
    }
  } catch (err) {
    // Fail-open on quota infra errors so a transient Postgres hiccup doesn't
    // block legitimate saves. The count check is best-effort defense in
    // depth; the database itself remains the source of truth.
    console.warn("[saved-wallets POST] quota check error", err);
  }

  // Is this wallet NEW to this user? Decided BEFORE the upsert, because after
  // it the row always exists. Only a genuinely new wallet earns the deep warm —
  // re-saving one the user already has must not kick off another full Cadence
  // re-walk. Fail-open to "new" is wrong (it would re-walk on every hiccup), so
  // an errored probe is treated as not-new and the wallet warms on the next
  // genuine entry point.
  let isNewWallet = false;
  try {
    const { count, error: probeErr } = await supabase
      .from("saved_wallets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("wallet_addr", walletAddr);
    isNewWallet = !probeErr && (count ?? 0) === 0;
  } catch (err) {
    console.warn("[saved-wallets POST] new-wallet probe error", err);
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
      return apiErrorResponse(error, "api/profile/saved-wallets");
    }

    // Deep cross-collection warm for the paste-an-address entry path. Until
    // 2026-08-08 this route dispatched NOTHING on insert, and its allow-list
    // self-heal keys off `allow_list` — so open-door signups (front door opened
    // 2026-07-20, no allow_list row) got a saved_wallets row and an empty
    // wallet_moments_cache. Fire-and-forget via after(): the orchestrator 202s
    // immediately and walks in its own background task.
    if (isNewWallet) {
      after(async () => {
        await warmWalletDeep(
          siteUrl(),
          process.env.INGEST_SECRET_TOKEN ?? "",
          walletAddr,
          "saved-wallets POST after"
        );
      });
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
  walletAddr = normalizeAddress(String(walletAddr));

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
      return apiErrorResponse(error, "api/profile/saved-wallets");
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
  walletAddr = normalizeAddress(walletAddr);

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
      return apiErrorResponse(error, "api/profile/saved-wallets");
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
