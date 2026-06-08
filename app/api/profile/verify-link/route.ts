// app/api/profile/verify-link/route.ts
//
// HybridCustody read-only wallet verification (CLAUDE.md known-issue #0).
//
// A Dapper Top Shot collector connects ANY Flow wallet via FCL account-proof —
// proving control of address A, with no transaction signed — and we verify a
// DIFFERENT saved wallet W when W is on-chain HybridCustody-linked to A (or
// W == A). Removes the listing-challenge friction for the core TS audience.
//
//   POST { wallet_addr: "0x<W>", accountProof: { address, nonce, signatures } }
//
// Trust boundary (mirrors app/api/auth/fcl-verify/route.ts, hardened d425998):
//   - proof.address (A) is the ONLY proven identity — validated cryptographically
//     by fcl.AppUtils.verifyAccountProof against a single-use server-minted nonce.
//   - The link from A to W comes ONLY from linked_accounts (on-chain HybridCustody
//     events) via get_all_linked_addresses — never from user input.
//   - On a confirmed link, verify_wallet_via_fcl(...,'hybrid_custody_link') — the
//     service-role-only SECDEF write path — is the ONLY thing that flips
//     saved_wallets.verified_at. user_id is requireUser()-resolved, never client.
//
// Unlike fcl-verify, the claimed wallet W is INTENTIONALLY different from the
// signed address A, so we do NOT assert W == proof.address — we assert the link.
// We do not insert saved_wallets here: W is verified from the user's existing
// saved list (the verify RPC UPDATEs existing rows), so a 0-row result means
// "save it first" (409), not a silent phantom row under the wrong collection.

import { NextRequest, NextResponse } from "next/server";
import * as fcl from "@onflow/fcl";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { awardPoints } from "@/lib/rewards";

const APP_IDENTIFIER = "Rip Packs City";

// Light per-user rate limit (best-effort, in-memory; Fluid Compute reuses
// instances) — mirrors verify-challenge/check.
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
  const t = s.trim().toLowerCase();
  return t.startsWith("0x") ? t : null;
}

function ensureFcl() {
  fcl.config()
    .put("accessNode.api", process.env.NEXT_PUBLIC_FCL_ACCESS_NODE ?? "https://rest-mainnet.onflow.org")
    .put("flow.network", "mainnet")
    .put("app.detail.title", APP_IDENTIFIER);
}

export async function POST(req: NextRequest) {
  ensureFcl();

  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", hint: "Wait a few seconds and try again." },
      { status: 429 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const claimed = normalizeAddr(body?.wallet_addr ?? body?.walletAddr);
  if (!claimed) {
    return NextResponse.json({ ok: false, error: "wallet_addr (0x...) required" }, { status: 400 });
  }

  const ap = body?.accountProof;
  if (!ap || typeof ap !== "object") {
    return NextResponse.json({ ok: false, error: "accountProof object required" }, { status: 400 });
  }
  const proof = ap as { address?: string; nonce?: string; signatures?: unknown };
  if (typeof proof.nonce !== "string" || !proof.nonce) {
    return NextResponse.json({ ok: false, error: "accountProof.nonce missing" }, { status: 400 });
  }

  // Confirm the nonce was minted by us (/api/auth/fcl-nonce), is unconsumed and
  // unexpired, then consume it before any verification work.
  const { data: nonceRow, error: nErr } = await supabase
    .from("fcl_auth_nonces")
    .select("id, consumed_at, expires_at")
    .eq("nonce", proof.nonce)
    .maybeSingle();
  if (nErr) return NextResponse.json({ ok: false, error: nErr.message }, { status: 500 });
  if (!nonceRow) return NextResponse.json({ ok: false, error: "Unknown nonce" }, { status: 401 });
  if (nonceRow.consumed_at) return NextResponse.json({ ok: false, error: "Nonce already used" }, { status: 401 });
  if (new Date(nonceRow.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ ok: false, error: "Nonce expired" }, { status: 401 });
  }
  await supabase
    .from("fcl_auth_nonces")
    .update({ consumed_at: new Date().toISOString(), consumed_by_addr: proof.address ?? null })
    .eq("id", nonceRow.id);

  // Cryptographic verification against the on-chain account named in the proof.
  let valid = false;
  try {
    valid = await (fcl as any).AppUtils.verifyAccountProof(APP_IDENTIFIER, proof, {
      fclCryptoContract: undefined,
    });
  } catch (e: any) {
    console.error("[verify-link] verify threw:", e?.message);
    return NextResponse.json({ ok: false, error: "Account proof verification failed" }, { status: 401 });
  }
  if (!valid || typeof proof.address !== "string") {
    return NextResponse.json({ ok: false, error: "Invalid account proof" }, { status: 401 });
  }

  // proof.address is the only proven identity. Verify the claimed wallet W only
  // if W == A or W is HybridCustody-linked to A (link graph from on-chain events
  // in linked_accounts, never from the request).
  const provenA = proof.address.toLowerCase();
  if (claimed !== provenA) {
    const { data: ld, error: lErr } = await supabase.rpc("get_all_linked_addresses", { addr: provenA });
    if (lErr) return NextResponse.json({ ok: false, error: lErr.message }, { status: 500 });
    const linked = (Array.isArray(ld) ? ld : []).map((a: unknown) => String(a).toLowerCase());
    if (!linked.includes(claimed)) {
      return NextResponse.json(
        {
          ok: false,
          matched: false,
          error: "not_linked",
          hint: "That wallet isn't HybridCustody-linked to the wallet you signed with — use the listing challenge instead.",
        },
        { status: 403 }
      );
    }
  }

  // Confirmed control of W (directly or via link). verify_wallet_via_fcl only
  // UPDATEs EXISTING saved_wallets rows for (user_id, W) — across every
  // collection the user saved W under — and is service_role-only SECDEF.
  const { data: verified, error: vErr } = await supabase.rpc("verify_wallet_via_fcl", {
    p_user_id: user.id,
    p_wallet_addr: claimed,
    p_method: "hybrid_custody_link",
  });
  if (vErr) return NextResponse.json({ ok: false, error: vErr.message }, { status: 500 });
  if (!Array.isArray(verified) || verified.length === 0) {
    return NextResponse.json(
      { ok: false, matched: true, error: "not_saved", hint: "Save this wallet to your collection first, then verify." },
      { status: 409 }
    );
  }

  // Rewards: first verified wallet earns link_wallet (per_user_limit=1, so repeat
  // verifies are harmless no-ops). Fire-and-forget — never blocks verification.
  await awardPoints(user.id, "link_wallet", claimed);

  return NextResponse.json({
    ok: true,
    matched: true,
    addr: claimed,
    via: claimed === provenA ? "self" : "hybrid_custody_link",
  });
}
