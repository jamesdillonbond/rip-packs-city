// app/api/profile/resolve-and-associate/route.ts
//
// Resolves a Dapper username to a Flow wallet address via Top Shot GQL, then
// auto-associates that wallet with the signed-in user's saved_wallets across
// every published Dapper marketplace (Top Shot, All Day, Golazos, Pinnacle).
//
// Dapper SSO enforces one username per wallet across all four marketplaces,
// so a Top Shot resolution is authoritative for the whole family.
//
// After the saved_wallets rows are upserted, `after()` warms the wallet so the
// user never has to navigate to each collection page to trigger indexing:
//
//   1. ONE dispatch to /api/wallet-backfill-multicollection (skip_cached=false)
//      — the DEEP Cadence walk across all 5 published Flow collections. It
//      returns 202 immediately and does the heavy work in its own after(), so
//      this route's after() just fires the POST and moves on.
//   2. A shallow Top Shot wallet-search for instant first-paint numbers, so the
//      /profile cards show something while the deep walk runs.
//   3. aggregate_saved_wallet_stats — reads wallet_moments_cache (source of
//      truth) and stamps cached_moment_count / cached_fmv_usd on every
//      saved_wallets row for this wallet.
//
// Prior to 2026-08-08 step 1 did not exist: the fan-out was a shallow
// `wallet-search` with `limit: 50` per collection. Open-door signups (front
// door opened 2026-07-20 — those users get no allow_list row, so they skip the
// approval-time prewarm entirely) landed page-capped at exactly 50 Top Shot
// moments and 0 in every other collection, because the shallow search
// short-circuits for several of them.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { resolveTopShotUsername } from "@/lib/chains/flow/topshot-username-resolve";
import { publishedCollections } from "@/lib/collections";
import { checkFeatureQuota } from "@/lib/pro-tier";
import { evaluateSavedWalletCap } from "@/lib/profile/saved-wallet-quota";
import { warmWalletDeep } from "@/lib/profile/warm-wallet";
import { isCadenceAddress, normalizeAddress } from "@/lib/address";

// Flow collections that should auto-attach to the resolved wallet on signup.
// NBA / All Day / Golazos / Pinnacle share Dapper SSO so the username is
// authoritative across them. UFC Strike runs its own Concept Labs account
// system, but the wallet address on Flow is the same — verified beta cohort
// (alxo, mbl267, rigged, samwise222, selanne8kariya9) all hold UFC moments
// at the wallet returned by the Top Shot resolver, so we add a UFC
// saved_wallets row too. Warming is no longer per-slug from here — the
// multicollection backfill dispatched in after() covers UFC (and every
// other collection) with a real Cadence walk.
const SEED_SLUGS = new Set([
  "nba-top-shot",
  "nfl-all-day",
  "laliga-golazos",
  "disney-pinnacle",
  "ufc",
]);

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.rippackscity.com")
  );
}

export async function POST(req: NextRequest) {
  // One-shot retry on getCurrentUser: the magic-link → /auth/confirm flow
  // can land here a few hundred ms before the SSR cookie write settles,
  // and proxy.ts setAll only writes refreshed Supabase cookies onto the
  // outgoing response — not back onto the inner request — so the route
  // can briefly see a stale/missing session even though the proxy gate
  // accepted the call. wallet-search is in the public bypass and never
  // triggers this 401, which is why the symptom appears asymmetric.
  let user = await getCurrentUser();
  if (!user) {
    await new Promise((r) => setTimeout(r, 250));
    user = await getCurrentUser();
  }
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: { username?: string; address?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Two ways in, one outcome. RPC asks for a public IDENTIFIER and never
  // connects a wallet (Trevor, 2026-08-08), so the dashboard's single field
  // accepts either shape and routes here. Everything below the resolve step
  // already runs off a bare `walletAddress`, so the address path just skips the
  // Top Shot GQL lookup — the quota check, the SEED_SLUGS fan-out, the deep
  // warm, and aggregate_saved_wallet_stats are all shared.
  const rawAddress = (body.address ?? "").trim();
  const rawUsername = (body.username ?? "").trim();

  let walletAddress: string;
  let username: string | null;

  if (rawAddress) {
    if (!isCadenceAddress(rawAddress)) {
      return NextResponse.json(
        { error: "That doesn't look like a Flow wallet address (0x + 16 hex characters)." },
        { status: 400 }
      );
    }
    walletAddress = normalizeAddress(rawAddress);
    username = null;
  } else {
    if (!rawUsername) {
      return NextResponse.json({ error: "username or address required" }, { status: 400 });
    }

    let resolved;
    try {
      resolved = await resolveTopShotUsername(rawUsername);
    } catch (err: any) {
      console.error("[resolve-and-associate] GQL error:", err?.message);
      return NextResponse.json(
        {
          error:
            "Couldn't reach the Top Shot directory right now. Try again in a minute, or enter your wallet address directly instead.",
        },
        { status: 502 }
      );
    }

    if (!resolved) {
      return NextResponse.json(
        {
          error:
            "Couldn't find that Dapper username. Double-check spelling or try entering your wallet address directly instead.",
        },
        { status: 404 }
      );
    }

    walletAddress = resolved.walletAddress;
    username = resolved.username;
  }

  const targets = publishedCollections().filter(
    (c) => SEED_SLUGS.has(c.id) && !!c.supabaseCollectionId
  );

  // Plan cap. This is the PRIMARY "Load my collection" path and had no quota
  // check at all, so it bypassed the saved-wallets cap entirely. Measured on
  // DISTINCT wallet_addr (one Dapper wallet = 5 rows here), and a re-resolve of
  // an already-saved wallet always passes so a capped user can still refresh.
  try {
    const { data: addrRows } = await supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("user_id", user.id)
      .limit(1000);

    const quota = await checkFeatureQuota(walletAddress, "saved_wallets_max");
    const maxAllowed = quota.daily_limit; // null = unlimited per quota RPC contract
    const { allowed, distinctCount } = evaluateSavedWalletCap(addrRows, walletAddress, maxAllowed);
    if (!allowed) {
      return NextResponse.json(
        {
          error: "plan_limit_reached",
          message: `Free plan supports ${maxAllowed} saved wallet${maxAllowed === 1 ? "" : "s"}. Remove the wallet you have saved, or upgrade to RPC Pro.`,
          plan: quota.plan,
          saved_wallet_count: distinctCount,
          saved_wallet_limit: maxAllowed,
          upgrade_url: "/pricing",
        },
        { status: 402 }
      );
    }
  } catch (err) {
    // Fail-open on quota infra errors — a transient Postgres hiccup must not
    // block a legitimate first wallet. Matches the saved-wallets POST posture.
    console.warn("[resolve-and-associate] quota check error", err);
  }

  const rows = targets.map((c) => ({
    user_id: user.id,
    wallet_addr: walletAddress,
    collection_id: c.supabaseCollectionId!,
    username,
    display_name: null as string | null,
    nickname: null as string | null,
    accent_color: c.accent,
  }));

  const { error } = await supabase
    .from("saved_wallets")
    .upsert(rows, { onConflict: "user_id,wallet_addr,collection_id" });

  if (error) {
    console.error("[resolve-and-associate] upsert error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // after() runs the callback once the response is flushed, so the client gets
  // its 200 immediately.
  const userId = user.id;
  after(async () => {
    const base = siteUrl();
    const ingestToken = process.env.INGEST_SECRET_TOKEN ?? "";

    // 1. DEEP warm across every published Flow collection. This is the one that
    //    actually fills wallet_moments_cache — /api/wallet-backfill-multicollection
    //    fans out to the per-collection Cadence walkers (Top Shot / Golazos / UFC
    //    fire-and-forget, All Day / Pinnacle sync-polled) and returns 202 right
    //    away, doing the multi-minute work inside its OWN after(). skip_cached
    //    is false so an existing page-capped cache is fully re-walked.
    await warmWalletDeep(base, ingestToken, walletAddress, "resolve-and-associate after");

    // 2. Shallow Top Shot pass purely for first paint. The deep walk above owns
    //    completeness; this just puts a non-zero number on the profile card
    //    within seconds instead of after the full walk. Deliberately NOT fanned
    //    out per collection any more — that was the under-warming bug.
    try {
      const res = await fetch(`${base}/api/wallet-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: walletAddress, collectionId: "nba-top-shot", limit: 50 }),
      });
      if (!res.ok) {
        console.warn(`[resolve-and-associate after] first-paint wallet-search HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.warn("[resolve-and-associate after] first-paint wallet-search failed:", err?.message);
    }

    // 3. Stamp the saved_wallets cards from wallet_moments_cache. The deep walk
    //    is still running at this point, so this reflects the first-paint state.
    //    Two things reconcile it upward once the walk lands rows — and until
    //    2026-08-08 NEITHER existed, which is why every card sat frozen at its
    //    signup value (41 of 99 rows drifting, all 21 users):
    //      a. wallet-backfill-multicollection now re-runs this same RPC at the
    //         end of its after(), i.e. after the deep walk it dispatched.
    //      b. pg_cron 'rpc-reconcile-saved-wallet-stats' (nightly 13:33 UTC)
    //         sweeps every saved wallet via reconcile_all_saved_wallet_stats().
    //    Nothing else writes these columns — wmc-fmv-populate does not.
    try {
      const { data, error } = await (supabase as any).rpc("aggregate_saved_wallet_stats", {
        p_user_id: userId,
        p_wallet_addr: walletAddress,
      });
      if (error) {
        console.warn("[resolve-and-associate after] aggregate RPC error:", error.message);
      } else {
        console.log(`[resolve-and-associate after] aggregate RPC updated ${data ?? 0} saved_wallets rows`);
      }
    } catch (err: any) {
      console.warn("[resolve-and-associate after] aggregate RPC threw:", err?.message);
    }
  });

  return NextResponse.json({
    username,
    walletAddress,
    associatedCollections: targets.map((c) => ({ id: c.id, label: c.label })),
  });
}
