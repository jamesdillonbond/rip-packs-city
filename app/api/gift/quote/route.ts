// app/api/gift/quote/route.ts
//
// Read-only preflight for parent-signed gifting. Requires a signed-in
// allow-listed user (goes through normal proxy auth — NOT a public carve-out).
//
// Validates every gift precondition on-chain (via the hybrid-custody-proxy) so
// the client only ever signs server-verified args and gets a clean reason
// instead of a mid-transaction panic that still burns gas.
//
//   POST { parentAddress, childAddress, momentId, recipient }
//   recipient = a raw 0x Flow address (Dapper OR Flow wallet), or a username
//               (RPC user_profiles / cached Top Shot wallet_usernames).
//
//   200 { ok:true, recipientReady, args:{childAddress,providerControllerID,momentId,recipient},
//         summary:{ momentTitle, serial, tier, imageUrl, recipientLabel } }
//   200 { ok:false, reason, recipientReady }   (preconditions not met — actionable)
//   4xx on bad input / auth.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { runGiftQuote, quoteFailureReason } from "@/lib/chains/flow/gift";

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
const ADDR_RE = /^0x[0-9a-f]{16}$/;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
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

function normAddr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return ADDR_RE.test(t) ? t : null;
}

// Resolve a recipient string to a Flow address + display label. Accepts a raw
// address or a username (RPC first, then cached Top Shot username).
async function resolveRecipient(
  input: string,
): Promise<{ addr: string; label: string | null } | null> {
  const direct = normAddr(input);
  if (direct) return { addr: direct, label: null };

  const uname = input.trim().replace(/^@/, "");
  if (!uname || uname.length > 64) return null;

  // RPC profile username or its stored topshot_username
  const { data: prof } = await supabase
    .from("user_profiles")
    .select("wallet_address, username")
    .or(`username.ilike.${uname},topshot_username.ilike.${uname}`)
    .not("wallet_address", "is", null)
    .limit(1)
    .maybeSingle();
  const profAddr = normAddr(prof?.wallet_address);
  if (profAddr) return { addr: profAddr, label: prof?.username ?? uname };

  // Cached Top Shot username -> wallet
  const { data: wu } = await supabase
    .from("wallet_usernames")
    .select("wallet_addr, username")
    .ilike("username", uname)
    .not("wallet_addr", "is", null)
    .limit(1)
    .maybeSingle();
  const wuAddr = normAddr(wu?.wallet_addr);
  if (wuAddr) return { addr: wuAddr, label: wu?.username ?? uname };

  return null;
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch (res) {
    return res as Response;
  }
  if (rateLimited(user.id)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const parent = normAddr(body?.parentAddress);
  const child = normAddr(body?.childAddress);
  const momentId = typeof body?.momentId === "string" || typeof body?.momentId === "number"
    ? String(body.momentId).trim()
    : null;
  const recipientRaw = typeof body?.recipient === "string" ? body.recipient : "";

  if (!parent) return NextResponse.json({ ok: false, error: "parentAddress (0x…16) required" }, { status: 400 });
  if (!child) return NextResponse.json({ ok: false, error: "childAddress (0x…16) required" }, { status: 400 });
  if (!momentId || !/^\d{1,20}$/.test(momentId)) {
    return NextResponse.json({ ok: false, error: "momentId (numeric) required" }, { status: 400 });
  }

  const recip = await resolveRecipient(recipientRaw);
  if (!recip) {
    return NextResponse.json({ ok: false, reason: "unknown_recipient" }, { status: 200 });
  }
  if (recip.addr === child) {
    return NextResponse.json({ ok: false, reason: "recipient_is_sender" }, { status: 200 });
  }

  let chain;
  try {
    chain = await runGiftQuote(parent, child, momentId, recip.addr);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "chain_read_failed", detail: String(e?.message ?? e).slice(0, 160) },
      { status: 502 },
    );
  }

  const reason = quoteFailureReason(chain);

  // Moment display (best-effort; ownership already verified on-chain).
  const { data: m } = await supabase
    .from("wallet_moments_cache")
    .select("player_name, character_name, set_name, edition_name, serial_number, tier, image_url, edition_key")
    .eq("wallet_address", child)
    .eq("collection_id", TOPSHOT_COLLECTION_ID)
    .eq("moment_id", momentId)
    .maybeSingle();

  const momentTitle =
    m?.player_name || m?.character_name || m?.edition_name || `Top Shot moment #${momentId}`;

  const summary = {
    momentTitle,
    setName: m?.set_name ?? null,
    serial: m?.serial_number ?? null,
    tier: m?.tier ?? null,
    imageUrl: m?.image_url ?? null,
    recipientLabel: recip.label,
    recipientAddr: recip.addr,
  };

  if (reason) {
    return NextResponse.json({ ok: false, reason, recipientReady: chain.recipientReady, summary });
  }

  return NextResponse.json({
    ok: true,
    recipientReady: chain.recipientReady,
    args: {
      childAddress: child,
      providerControllerID: chain.providerControllerID,
      momentId,
      recipient: recip.addr,
    },
    summary,
  });
}
