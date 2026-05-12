// app/api/mcp/keys/[keyId]/route.ts
//
// DELETE /api/mcp/keys/:keyId — revokes an MCP API key.
//
// Auth chain (same as siblings):
//   1. getCurrentUser() — 401 if no Supabase session
//   2. Look up the key's wallet_address via the service-role client.
//      The key may already be revoked or not exist; either case returns 404.
//   3. Confirm that wallet is in the user's saved_wallets via
//      get_user_saved_wallets(user.id). 403 if not — ownership check.
//   4. Call mcp_revoke_api_key(key_id, wallet_address). The RPC also
//      enforces (wallet matches) as defense in depth.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

interface SavedWalletRow {
  wallet_addr: string | null;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function loadUserWalletSet(userId: string): Promise<Set<string>> {
  const { data, error } = await (supabase as any).rpc("get_user_saved_wallets", { p_user_id: userId });
  if (error) throw new Error("saved_wallets_unavailable");
  const rows = (data ?? []) as SavedWalletRow[];
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.wallet_addr) continue;
    const w = r.wallet_addr.startsWith("0x") ? r.wallet_addr.toLowerCase() : "0x" + r.wallet_addr.toLowerCase();
    set.add(w);
  }
  return set;
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ keyId: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { keyId } = await ctx.params;
  if (!keyId || !isUuid(keyId)) {
    return NextResponse.json({ error: "keyId must be a UUID" }, { status: 400 });
  }

  // Look up the key's wallet without exposing any other surface
  const { data: keyRows, error: lookupErr } = await (supabase as any)
    .from("mcp_api_keys")
    .select("wallet_address, status")
    .eq("key_id", keyId)
    .limit(1);
  if (lookupErr) {
    console.log("[mcp/keys DELETE] lookup failed:", lookupErr.message);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
  const keyRow = (keyRows ?? [])[0] as { wallet_address: string | null; status: string } | undefined;
  if (!keyRow) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }
  const keyWallet =
    keyRow.wallet_address?.toLowerCase().startsWith("0x")
      ? keyRow.wallet_address.toLowerCase()
      : "0x" + (keyRow.wallet_address ?? "").toLowerCase();

  let userWallets: Set<string>;
  try {
    userWallets = await loadUserWalletSet(user.id);
  } catch {
    return NextResponse.json({ error: "Saved-wallet lookup failed" }, { status: 500 });
  }
  if (!userWallets.has(keyWallet)) {
    return NextResponse.json({ error: "Key does not belong to this account" }, { status: 403 });
  }

  // mcp_revoke_api_key returns false if the key is already revoked or
  // the (key_id, wallet_address) pair doesn't match. Either is benign
  // here — we already confirmed ownership at the HTTP layer.
  const { data: revoked, error: revokeErr } = await (supabase as any).rpc("mcp_revoke_api_key", {
    p_key_id: keyId,
    p_wallet_address: keyWallet,
  });
  if (revokeErr) {
    console.log("[mcp/keys DELETE] revoke failed:", revokeErr.message);
    return NextResponse.json({ error: "Revoke failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, revoked: revoked === true, key_id: keyId });
}
