// app/api/profile/resolve-and-associate/route.ts
//
// Resolves a Dapper username to a Flow wallet address via Top Shot GQL, then
// auto-associates that wallet with the signed-in user's saved_wallets across
// every published Dapper marketplace (Top Shot, All Day, Golazos, Pinnacle).
//
// Dapper SSO enforces one username per wallet across all four marketplaces,
// so a Top Shot resolution is authoritative for the whole family.
//
// After the saved_wallets rows are upserted, we fire 4 parallel wallet-search
// POSTs via `after()` so wallet_moments_cache starts populating immediately
// — the user shouldn't need to navigate to each collection page to trigger
// indexing. Each completed wallet-search response is summarised and written
// back to saved_wallets (cached_moment_count, cached_fmv_usd) so the
// /profile cards and the HeroMoment card populate without a manual refresh.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { resolveTopShotUsername } from "@/lib/topshot-username-resolve";
import { publishedCollections } from "@/lib/collections";

// Marketplaces that share the Dapper SSO username + wallet. UFC Strike is a
// Flow collection but uses a separate Concept Labs account model, so it is
// intentionally excluded from the auto-fanout.
const DAPPER_SSO_SLUGS = new Set([
  "nba-top-shot",
  "nfl-all-day",
  "laliga-golazos",
  "disney-pinnacle",
]);

function siteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://rip-packs-city.vercel.app")
  );
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: { username?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawUsername = (body.username ?? "").trim();
  if (!rawUsername) {
    return NextResponse.json({ error: "username required" }, { status: 400 });
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

  const walletAddress = resolved.walletAddress;
  const username = resolved.username;

  const targets = publishedCollections().filter(
    (c) => DAPPER_SSO_SLUGS.has(c.id) && !!c.supabaseCollectionId
  );

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

  // Fire-and-forget: kick off wallet-search for every associated collection so
  // wallet_moments_cache populates without requiring the user to navigate.
  // after() runs the callback after the response is flushed, so the client
  // gets its 200 immediately.
  //
  // Once all 4 wallet-searches settle, we call aggregate_saved_wallet_stats —
  // a single Postgres RPC that reads directly from wallet_moments_cache
  // (source of truth) and updates all saved_wallets rows for this wallet.
  // Previously we derived counts from each wallet-search response body, but
  // that path wrote zeros whenever the route short-circuited (Pinnacle/UFC/
  // Golazos) or returned only a limited page of rows.
  const userId = user.id;
  after(async () => {
    const base = siteUrl();
    await Promise.allSettled(
      targets.map(async (c) => {
        const slug = c.id;
        try {
          const res = await fetch(`${base}/api/wallet-search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: walletAddress, collectionId: slug, limit: 50 }),
          });
          if (!res.ok) {
            console.warn(`[resolve-and-associate after] ${slug} wallet-search HTTP ${res.status}`);
          }
        } catch (err: any) {
          console.warn(`[resolve-and-associate after] ${slug} fetch failed:`, err?.message);
        }
      })
    );

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
