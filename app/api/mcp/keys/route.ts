// app/api/mcp/keys/route.ts
//
// User-facing MCP API-key management. Reuses the established dashboard
// auth pattern exactly — get_user_saved_wallets(p_user_id) as the
// canonical session→wallet resolver, matching /api/profile/cost-basis-summary
// and /api/profile/verify-challenge. No new auth flow.
//
//   POST   /api/mcp/keys                       body { label?, wallet_address? }
//   GET    /api/mcp/keys                       lists every key across the user's saved wallets
//   DELETE /api/mcp/keys/[keyId]               see app/api/mcp/keys/[keyId]/route.ts
//
// All three handlers use the service-role Supabase client. The MCP RPCs
// themselves are SECDEF granted to service_role only — wrong-tier clients
// would fail at the SQL boundary, but we want clean 401s at the HTTP layer
// and never expose internal RPC errors to the caller.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

export const dynamic = "force-dynamic";

interface SavedWalletRow {
  wallet_addr: string | null;
  collection_id: string | null;
  collection_slug: string | null;
  nickname: string | null;
}

interface KeyRow {
  key_id: string;
  key_prefix: string;
  label: string | null;
  plan: string;
  status: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

// Returns the deduplicated set of wallet addresses the authenticated user
// owns, as lowercase 0x-hex strings. The RPC returns one row per
// (wallet_addr, collection_id) pair so we dedup on wallet here.
async function loadUserWallets(userId: string): Promise<{ wallets: string[]; raw: SavedWalletRow[] }> {
  const { data, error } = await (supabase as any).rpc("get_user_saved_wallets", { p_user_id: userId });
  if (error) {
    console.log("[mcp/keys] get_user_saved_wallets failed:", error.message);
    throw new Error("saved_wallets_unavailable");
  }
  const rows = (data ?? []) as SavedWalletRow[];
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.wallet_addr) continue;
    const w = r.wallet_addr.startsWith("0x") ? r.wallet_addr.toLowerCase() : "0x" + r.wallet_addr.toLowerCase();
    set.add(w);
  }
  return { wallets: Array.from(set), raw: rows };
}

function normalizeAddr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  if (!t.startsWith("0x") || t.length < 6) return null;
  return t;
}

// ─── POST /api/mcp/keys ────────────────────────────────────────────────────
//
// Body: { label?: string, wallet_address?: string }
// If wallet_address is provided, server validates it is one of the user's
// saved wallets. If omitted, server defaults to the first saved wallet.
// Returns the raw key exactly once — caller MUST surface it immediately
// because the value is never persisted in plaintext.

interface PostBody {
  label?: string;
  wallet_address?: string;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    // Empty body is OK — label optional, wallet falls back to first saved
  }

  let userWallets: string[];
  try {
    userWallets = (await loadUserWallets(user.id)).wallets;
  } catch {
    return NextResponse.json({ error: "Saved-wallet lookup failed" }, { status: 500 });
  }

  if (userWallets.length === 0) {
    return NextResponse.json(
      {
        error: "no_saved_wallets",
        message: "Save a wallet on the dashboard before creating an MCP API key.",
      },
      { status: 400 }
    );
  }

  const requested = normalizeAddr(body.wallet_address);
  let wallet: string;
  if (requested) {
    if (!userWallets.includes(requested)) {
      return NextResponse.json({ error: "Wallet not saved on this account" }, { status: 403 });
    }
    wallet = requested;
  } else {
    wallet = userWallets[0];
  }

  const label =
    typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : null;

  const { data, error } = await (supabase as any).rpc("mcp_issue_api_key", {
    p_wallet_address: wallet,
    p_label: label,
    p_scopes: ["read"],
  });

  if (error) {
    console.log("[mcp/keys POST] issue failed:", error.message);
    return NextResponse.json({ error: "Failed to issue key" }, { status: 500 });
  }

  const row = Array.isArray(data) && data.length > 0 ? data[0] : data;
  if (!row || !row.raw_key) {
    return NextResponse.json({ error: "Issue returned no key" }, { status: 500 });
  }

  // The raw_key is returned EXACTLY ONCE. It is never persisted in plaintext.
  // The client surfaces it in a modal and the user copies it. After this
  // response no path can recover the raw value.
  return NextResponse.json({
    ok: true,
    key_id: row.key_id,
    raw_key: row.raw_key,
    key_prefix: row.key_prefix,
    wallet_address: wallet,
    label,
  });
}

// ─── GET /api/mcp/keys ─────────────────────────────────────────────────────
//
// Returns every key across every saved wallet of the authenticated user,
// flat. No hashes, no raw values — mcp_list_keys is defined to project
// only the safe surface (key_id, key_prefix, label, plan, status, scopes,
// timestamps).

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let userWallets: string[];
  try {
    userWallets = (await loadUserWallets(user.id)).wallets;
  } catch {
    return NextResponse.json({ error: "Saved-wallet lookup failed" }, { status: 500 });
  }

  if (userWallets.length === 0) {
    return NextResponse.json({ ok: true, keys: [] });
  }

  const all: Array<KeyRow & { wallet_address: string }> = [];
  for (const wallet of userWallets) {
    const { data, error } = await (supabase as any).rpc("mcp_list_keys", { p_wallet_address: wallet });
    if (error) {
      console.log(`[mcp/keys GET] mcp_list_keys failed for ${wallet}:`, error.message);
      continue;
    }
    const rows = (data ?? []) as KeyRow[];
    for (const r of rows) all.push({ ...r, wallet_address: wallet });
  }

  all.sort((a, b) => {
    const at = a.created_at ? Date.parse(a.created_at) : 0;
    const bt = b.created_at ? Date.parse(b.created_at) : 0;
    return bt - at;
  });

  return NextResponse.json({ ok: true, keys: all });
}
