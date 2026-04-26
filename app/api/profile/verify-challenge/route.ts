// app/api/profile/verify-challenge/route.ts
//
// Listing-amount fallback verification. Lets a user prove they own a
// wallet by listing any moment at a unique random USD amount that we
// generate per-challenge. Resolution is automatic via the
// resolve_wallet_verification_challenges() RPC, which the listing-cache
// crons call after each successful poll.
//
//   POST   { wallet_addr }              → mints a new challenge
//   GET    ?wallet_addr=...             → returns the active challenge
//   PATCH  { wallet_addr? }             → forces a resolver pass + status

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";

const CHALLENGE_TTL_MIN = 30;

function randomChallengeAmount(): number {
  // Random value in [1.13, 9.99], rounded to 2dp, avoiding round whole-dollar
  // and clean .50 amounts so collisions with normal listing prices are rare.
  for (let i = 0; i < 16; i++) {
    const cents = Math.floor(Math.random() * (999 - 113 + 1)) + 113;
    const centsMod = cents % 100;
    if (centsMod === 0 || centsMod === 50) continue;
    return Math.round(cents) / 100;
  }
  return 1.37;
}

function normalizeAddr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t.startsWith("0x")) return null;
  return t.toLowerCase();
}

export async function POST(req: NextRequest) {
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

  const wallet = normalizeAddr(body?.wallet_addr ?? body?.walletAddr);
  if (!wallet) {
    return NextResponse.json({ error: "wallet_addr (0x...) required" }, { status: 400 });
  }

  // Confirm the user actually has this wallet saved before issuing a challenge.
  const { data: saved } = await supabase
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .limit(1);
  if (!saved || saved.length === 0) {
    return NextResponse.json({ error: "Wallet not saved on this account" }, { status: 403 });
  }

  // Cancel any prior unresolved challenges for the same wallet so each
  // physical wallet only has one open puzzle at a time.
  await supabase
    .from("wallet_verification_challenges")
    .update({ resolved_at: new Date().toISOString(), resolved_via: "superseded" })
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .is("resolved_at", null);

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MIN * 60 * 1000).toISOString();
  const amount = randomChallengeAmount();

  const { data: inserted, error } = await supabase
    .from("wallet_verification_challenges")
    .insert({
      user_id: user.id,
      wallet_addr: wallet,
      challenge_amount: amount,
      expires_at: expiresAt,
    })
    .select("id, wallet_addr, challenge_amount, expires_at")
    .single();

  if (error) {
    console.error("[verify-challenge POST]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ challenge: inserted });
}

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  const wallet = normalizeAddr(req.nextUrl.searchParams.get("wallet_addr"));
  if (!wallet) {
    return NextResponse.json({ error: "wallet_addr query param required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("wallet_verification_challenges")
    .select("id, wallet_addr, challenge_amount, created_at, expires_at, resolved_at, resolved_via, matched_moment_id")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const row = data?.[0] ?? null;
  if (!row) {
    return NextResponse.json({ challenge: null });
  }

  const expired =
    !row.resolved_at && new Date(row.expires_at).getTime() < Date.now();
  return NextResponse.json({
    challenge: {
      ...row,
      expired,
      msRemaining: expired ? 0 : Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
    },
  });
}

export async function PATCH(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const wallet = normalizeAddr(body?.wallet_addr ?? body?.walletAddr);

  // Run the matcher on every call — cheap idempotent SQL pass.
  const { data: resolved, error: resErr } = await supabase.rpc(
    "resolve_wallet_verification_challenges"
  );
  if (resErr) {
    console.error("[verify-challenge PATCH] resolver:", resErr.message);
  }

  // Fetch this user's most recent challenge so the client can update status.
  let q = supabase
    .from("wallet_verification_challenges")
    .select("id, wallet_addr, challenge_amount, created_at, expires_at, resolved_at, resolved_via, matched_moment_id")
    .eq("user_id", user.id);
  if (wallet) q = q.eq("wallet_addr", wallet);
  const { data: rows, error: rowErr } = await q
    .order("created_at", { ascending: false })
    .limit(1);
  if (rowErr) {
    return NextResponse.json({ error: rowErr.message }, { status: 500 });
  }

  const row = rows?.[0] ?? null;
  return NextResponse.json({
    resolvedThisPass: Array.isArray(resolved)
      ? resolved.filter((r: any) => r?.user_id === user.id).length
      : 0,
    challenge: row
      ? {
          ...row,
          expired:
            !row.resolved_at &&
            new Date(row.expires_at).getTime() < Date.now(),
          msRemaining: row.resolved_at
            ? 0
            : Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
        }
      : null,
  });
}
