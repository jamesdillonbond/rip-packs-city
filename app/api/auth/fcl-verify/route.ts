// app/api/auth/fcl-verify/route.ts
//
// Verifies an FCL Account Proof and either (a) marks the wallet verified on
// the current authenticated user's saved_wallets rows, or (b) bootstraps a
// brand-new Supabase Auth session keyed by a synthetic "<addr>@flow.rip-
// packs-city.local" email when no session exists.
//
// Returns:
//   { ok: true, addr, sessionTokenHash?: string, mode: "linked" | "minted" }
//
// When mode = "minted", the client must exchange the returned tokenHash via
// supabase.auth.verifyOtp({ token_hash, type: "magiclink" }) to land a
// session cookie. When mode = "linked" (user was already signed in), no
// token exchange is needed.

import { NextRequest, NextResponse } from "next/server";
import * as fcl from "@onflow/fcl";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

const APP_IDENTIFIER = "Rip Packs City";

function syntheticEmail(addr: string): string {
  return `${addr.toLowerCase()}@flow.rip-packs-city.local`;
}

function ensureFclConfigured() {
  // FCL stores config globally, so configuring once per cold start is fine.
  fcl.config()
    .put("accessNode.api", process.env.NEXT_PUBLIC_FCL_ACCESS_NODE ?? "https://rest-mainnet.onflow.org")
    .put("flow.network", "mainnet")
    .put("app.detail.title", APP_IDENTIFIER);
}

export async function POST(req: NextRequest) {
  ensureFclConfigured();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const addrRaw: unknown = body?.addr;
  const accountProof: unknown = body?.accountProof;
  if (typeof addrRaw !== "string" || !addrRaw.startsWith("0x")) {
    return NextResponse.json({ error: "addr (0x...) required" }, { status: 400 });
  }
  if (!accountProof || typeof accountProof !== "object") {
    return NextResponse.json({ error: "accountProof object required" }, { status: 400 });
  }
  const addr = addrRaw.toLowerCase();
  const proof = accountProof as { nonce?: string; signatures?: unknown };

  if (typeof proof.nonce !== "string" || !proof.nonce) {
    return NextResponse.json({ error: "accountProof.nonce missing" }, { status: 400 });
  }

  // Confirm the nonce was minted by us, is unconsumed, and unexpired.
  const { data: nonceRow, error: nonceErr } = await supabase
    .from("fcl_auth_nonces")
    .select("id, nonce, consumed_at, expires_at")
    .eq("nonce", proof.nonce)
    .maybeSingle();

  if (nonceErr) {
    return NextResponse.json({ error: nonceErr.message }, { status: 500 });
  }
  if (!nonceRow) {
    return NextResponse.json({ error: "Unknown nonce" }, { status: 401 });
  }
  if (nonceRow.consumed_at) {
    return NextResponse.json({ error: "Nonce already used" }, { status: 401 });
  }
  if (new Date(nonceRow.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "Nonce expired" }, { status: 401 });
  }

  // Cryptographic verification against the on-chain account.
  let valid = false;
  try {
    valid = await (fcl as any).AppUtils.verifyAccountProof(
      APP_IDENTIFIER,
      proof,
      { fclCryptoContract: undefined }
    );
  } catch (e: any) {
    console.error("[auth/fcl-verify] verify threw:", e?.message);
    return NextResponse.json({ error: "Account proof verification failed" }, { status: 401 });
  }

  if (!valid) {
    return NextResponse.json({ error: "Invalid account proof" }, { status: 401 });
  }

  // Mark the nonce consumed before doing any session work.
  await supabase
    .from("fcl_auth_nonces")
    .update({ consumed_at: new Date().toISOString(), consumed_by_addr: addr })
    .eq("id", nonceRow.id);

  // If the caller already has a Supabase session, just attach + verify the
  // wallet to that user. No new identity needed.
  const existingUser = await getCurrentUser();
  if (existingUser) {
    await supabase.rpc("verify_wallet_via_fcl", {
      p_user_id: existingUser.id,
      p_wallet_addr: addr,
      p_method: "fcl_dapper",
    });
    return NextResponse.json({
      ok: true,
      mode: "linked",
      addr,
      userId: existingUser.id,
    });
  }

  // No existing session — mint a synthetic-email-keyed user (idempotent) and
  // hand the client a magic-link OTP token to redeem for a session.
  const email = syntheticEmail(addr);

  // createUser is idempotent enough for our purposes; we only treat duplicate-
  // user errors as success (the row already exists, that's fine).
  try {
    const { error: createErr } = await (supabase.auth as any).admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { flow_addr: addr, auth_method: "fcl_dapper" },
    });
    if (createErr && !/already (registered|been registered|exists)/i.test(createErr.message ?? "")) {
      console.error("[auth/fcl-verify] createUser:", createErr.message);
    }
  } catch (e: any) {
    if (!/already/i.test(e?.message ?? "")) {
      console.error("[auth/fcl-verify] createUser threw:", e?.message);
    }
  }

  const { data: linkData, error: linkErr } = await (supabase.auth as any).admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    console.error("[auth/fcl-verify] generateLink:", linkErr?.message);
    return NextResponse.json({ error: linkErr?.message ?? "Failed to mint session" }, { status: 500 });
  }

  // Look up the user_id we just created/found and verify the wallet on it.
  const { data: userRow } = await (supabase.auth as any).admin.listUsers({
    page: 1,
    perPage: 1,
    email,
  });
  const newUserId: string | undefined = userRow?.users?.[0]?.id;
  if (newUserId) {
    await supabase.rpc("verify_wallet_via_fcl", {
      p_user_id: newUserId,
      p_wallet_addr: addr,
      p_method: "fcl_dapper",
    });
  }

  return NextResponse.json({
    ok: true,
    mode: "minted",
    addr,
    email,
    tokenHash: linkData.properties.hashed_token,
    userId: newUserId ?? null,
  });
}
