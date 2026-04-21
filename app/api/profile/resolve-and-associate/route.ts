// app/api/profile/resolve-and-associate/route.ts
//
// Resolves a Dapper username to a Flow wallet address via Top Shot GQL, then
// auto-associates that wallet with the signed-in user's saved_wallets across
// every published Dapper marketplace (Top Shot, All Day, Golazos, Pinnacle).
//
// Dapper SSO enforces one username per wallet across all four marketplaces,
// so a Top Shot resolution is authoritative for the whole family.

import { NextRequest, NextResponse } from "next/server";
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

  return NextResponse.json({
    username,
    walletAddress,
    associatedCollections: targets.map((c) => ({ id: c.id, label: c.label })),
  });
}
