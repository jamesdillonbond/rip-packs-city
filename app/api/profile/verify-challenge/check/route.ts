// app/api/profile/verify-challenge/check/route.ts
//
// On-demand wallet-verification check. The original resolver
// (resolve_wallet_verification_challenges) matched challenges against
// cached_listings, which has been frozen since the TS listings indexer was
// retired (2026-05-26) / Flowty shut down (2026-05-13) — 0 of 6 matched
// lifetime. This endpoint replaces it with a LIVE check.
//
// Design (2026-06-07): RPC picks the target Moment at mint time and stores it
// on the challenge (target_moment_id). The user lists THAT Moment at the
// challenge amount via a deep link. This check confirms, through Top Shot's
// own API, that the target is currently for-sale at exactly the challenge
// amount — proof-of-control (only the owner can list it at that unique price).
//
//   POST { wallet_addr }
//
// On a confirmed match the route (and ONLY then) calls the service-role RPC
// resolve_wallet_challenge_match, which atomically marks the challenge
// resolved, flips saved_wallets.verified_at, and awards link_wallet (+500).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { fetchMomentListingState, priceMatchesCents } from "@/lib/verify-wallet-gql";

// Light per-user rate limit so repeated "check" clicks stay polite to the
// upstream API. Best-effort, in-memory (Fluid Compute reuses instances).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 6;
const rateHits = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const arr = (rateHits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    rateHits.set(userId, arr);
    return true;
  }
  arr.push(now);
  rateHits.set(userId, arr);
  return false;
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

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { ok: false, matched: false, error: "rate_limited", hint: "Too many checks — wait a few seconds and try again." },
      { status: 429 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const wallet = normalizeAddr(body?.wallet_addr ?? body?.walletAddr);
  if (!wallet) {
    return NextResponse.json({ ok: false, error: "wallet_addr (0x...) required" }, { status: 400 });
  }

  // Optional referrer (from the ?ref= stash, see RefCapture). Accept only a
  // well-formed uuid; the DB function owns all trust logic (first-verification-
  // only, no self-referral, referrer must exist) — we just forward it.
  const refRaw = typeof body?.ref === "string" ? body.ref.trim() : "";
  const referrer = /^[0-9a-f-]{36}$/i.test(refRaw) ? refRaw : null;

  // Load the caller's active (unresolved, unexpired) challenge for this wallet.
  const { data: challenges, error: chErr } = await supabase
    .from("wallet_verification_challenges")
    .select("id, challenge_amount, target_moment_id, expires_at")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .is("resolved_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  if (chErr) {
    return NextResponse.json({ ok: false, error: chErr.message }, { status: 500 });
  }
  const challenge = challenges?.[0] ?? null;
  if (!challenge) {
    return NextResponse.json(
      { ok: false, matched: false, error: "no_active_challenge", hint: "Start a new challenge — the previous one expired or was already used." },
      { status: 404 }
    );
  }
  if (!challenge.target_moment_id) {
    // Legacy challenge with no server-chosen target — can't be checked live.
    return NextResponse.json(
      { ok: false, matched: false, error: "legacy_challenge", hint: "Start a fresh challenge to verify by listing." },
      { status: 409 }
    );
  }
  const amount = Number(challenge.challenge_amount);
  const targetMomentId = String(challenge.target_moment_id);

  // Live GQL: is the target moment for-sale at exactly the challenge amount?
  let state;
  try {
    state = await fetchMomentListingState(targetMomentId);
  } catch (err) {
    console.error("[verify-challenge/check] GQL:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { ok: false, matched: false, error: "gql_unavailable", hint: "Top Shot's API didn't respond — try again in a moment." },
      { status: 502 }
    );
  }

  if (!state.forSale || !priceMatchesCents(state.price, amount)) {
    return NextResponse.json({
      ok: false,
      matched: false,
      hint: `Not seeing it yet — confirm the Moment is listed at exactly $${amount.toFixed(2)} and try again in about a minute.`,
    });
  }

  // Confirmed match — resolve via the service-role RPC (the ONLY write path).
  const { data: resolved, error: resErr } = await supabase.rpc("resolve_wallet_challenge_match", {
    p_challenge_id: challenge.id,
    p_matched_moment_id: targetMomentId,
    p_source: "gql_on_demand",
    p_referrer: referrer,
  });
  if (resErr) {
    console.error("[verify-challenge/check] resolve RPC:", resErr.message);
    return NextResponse.json({ ok: false, matched: true, error: resErr.message }, { status: 500 });
  }

  const r = (resolved ?? {}) as Record<string, any>;
  if (r.ok === false) {
    // Race: challenge resolved/expired between our load and the RPC's lock.
    return NextResponse.json({ ok: false, matched: true, ...r });
  }

  return NextResponse.json({
    ok: true,
    matched: true,
    wallet,
    moment: targetMomentId,
    link_wallet_award: r.link_wallet_award ?? null,
    referral_award: r.referral_award ?? null,
    ...r,
  });
}
