# Handoff 2026-06-08 — build the HybridCustody read-only verify path (get it live)

Spec: docs/features/hybrid-custody-verify-path-2026-06-08.md. Premises verified live (B/C/D hold; the gate's 3 security vectors are now CLOSED — vectors i/ii via audit_20260608_close_verified_wallet_selfwrite_holes, vector #1 via your route fix `d425998`). The path is unblocked to build. Cowork can't push code, so this is the CC half: one DB migration + one route + one UI button. All shapes below were read live this session — but your direct file inspection wins on any mismatch.

WHAT THIS FEATURE DOES
A Dapper TS collector who also controls a self-custody Flow wallet that is HybridCustody-linked to their Dapper account can verify read-only: connect any Flow wallet via FCL account-proof (no transaction signed), and we verify a DIFFERENT saved wallet W when W is on-chain-linked to the signed address A (or W==A). Removes the listing-challenge friction for the core audience. TSCR (topshotcommunityrewards.com) is live proof collectors do this.

ITEM 1 — DB migration (add the method, re-assert service_role-only)
verify_wallet_via_fcl currently rejects unknown methods: `IF p_method NOT IN ('fcl_dapper','fcl_blocto','fcl_other') THEN RAISE`. Add 'hybrid_custody_link'. The function was just hardened to service_role-only EXECUTE (vector ii) — CREATE OR REPLACE resets grants, so RE-ASSERT (do NOT re-grant authenticated). Apply via Supabase MCP / Cowork (or a CC-run migration). Exact body (only the IN-list line changes vs live):

CREATE OR REPLACE FUNCTION public.verify_wallet_via_fcl(p_user_id uuid, p_wallet_addr text, p_method text DEFAULT 'fcl_dapper'::text)
 RETURNS TABLE(saved_wallet_id bigint, collection_id uuid, verified_at timestamp with time zone)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '5s'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;
  IF p_method NOT IN ('fcl_dapper', 'fcl_blocto', 'fcl_other', 'hybrid_custody_link') THEN
    RAISE EXCEPTION 'Invalid verification method: %', p_method;
  END IF;
  UPDATE wallet_verification_challenges SET resolved_at = now(), resolved_via = 'superseded_by_fcl'
  WHERE user_id = p_user_id AND LOWER(wallet_addr) = LOWER(p_wallet_addr) AND resolved_at IS NULL;
  RETURN QUERY
  UPDATE saved_wallets sw SET verified_at = now(), verification_method = p_method
  WHERE sw.user_id = p_user_id AND LOWER(sw.wallet_addr) = LOWER(p_wallet_addr)
  RETURNING sw.id, sw.collection_id, sw.verified_at;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.verify_wallet_via_fcl(uuid, text, text) FROM authenticated, anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_wallet_via_fcl(uuid, text, text) TO service_role;

Verify after: the grant query shows EXECUTE for service_role only; a call with p_method='hybrid_custody_link' no longer RAISEs.

ITEM 2 — new route app/api/profile/verify-link/route.ts (full file below)
Mirrors app/api/auth/fcl-verify/route.ts (nonce + verifyAccountProof + the addr===proof.address discipline you just shipped) and verify-challenge/check (requireUser + in-memory rate limit). CONFIRM against the real files: the awardPoints signature, requireUser's throw-Response contract, and the saved_wallets save path (mirror how app/api/profile/saved-wallets/route.ts upserts — the onConflict target + whether collection_id is required differ from my assumption; if a wallet is stored per-collection, the verify RPC already UPDATEs all matching rows, which is fine).

// app/api/profile/verify-link/route.ts
// HybridCustody read-only wallet verification (known-issue #0). Connect any Flow
// wallet via FCL account-proof (proves control of A, no tx signed); verify a saved
// wallet W when W is HybridCustody-linked to A (or W==A). Link graph comes ONLY
// from linked_accounts (on-chain events). On a confirmed link, the service-role RPC
// verify_wallet_via_fcl(...,'hybrid_custody_link') is the ONLY write path.
//   POST { wallet_addr: "0x<W>", accountProof: { address, nonce, signatures } }
import { NextRequest, NextResponse } from "next/server";
import * as fcl from "@onflow/fcl";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/supabase-server";
import { awardPoints } from "@/lib/rewards";

const APP_IDENTIFIER = "Rip Packs City";
const RATE_WINDOW_MS = 60_000, RATE_MAX = 6;
const rateHits = new Map<string, number[]>();
function rateLimited(id: string): boolean {
  const now = Date.now();
  const arr = (rateHits.get(id) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { rateHits.set(id, arr); return true; }
  arr.push(now); rateHits.set(id, arr); return false;
}
function normalizeAddr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return t.startsWith("0x") ? t : null;
}
function ensureFcl() {
  fcl.config()
    .put("accessNode.api", process.env.NEXT_PUBLIC_FCL_ACCESS_NODE ?? "https://rest-mainnet.onflow.org")
    .put("flow.network", "mainnet").put("app.detail.title", APP_IDENTIFIER);
}
export async function POST(req: NextRequest) {
  ensureFcl();
  let user;
  try { user = await requireUser(); } catch (res) { return res as Response; }
  if (rateLimited(user.id)) return NextResponse.json({ ok: false, error: "rate_limited", hint: "Wait a few seconds." }, { status: 429 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  const claimed = normalizeAddr(body?.wallet_addr ?? body?.walletAddr);
  if (!claimed) return NextResponse.json({ ok: false, error: "wallet_addr (0x...) required" }, { status: 400 });
  const ap = body?.accountProof;
  if (!ap || typeof ap !== "object") return NextResponse.json({ ok: false, error: "accountProof object required" }, { status: 400 });
  const proof = ap as { address?: string; nonce?: string; signatures?: unknown };
  if (typeof proof.nonce !== "string" || !proof.nonce) return NextResponse.json({ ok: false, error: "accountProof.nonce missing" }, { status: 400 });
  const { data: nonceRow, error: nErr } = await supabase.from("fcl_auth_nonces").select("id, consumed_at, expires_at").eq("nonce", proof.nonce).maybeSingle();
  if (nErr) return NextResponse.json({ ok: false, error: nErr.message }, { status: 500 });
  if (!nonceRow) return NextResponse.json({ ok: false, error: "Unknown nonce" }, { status: 401 });
  if (nonceRow.consumed_at) return NextResponse.json({ ok: false, error: "Nonce already used" }, { status: 401 });
  if (new Date(nonceRow.expires_at).getTime() < Date.now()) return NextResponse.json({ ok: false, error: "Nonce expired" }, { status: 401 });
  await supabase.from("fcl_auth_nonces").update({ consumed_at: new Date().toISOString(), consumed_by_addr: proof.address ?? null }).eq("id", nonceRow.id);
  let valid = false;
  try { valid = await (fcl as any).AppUtils.verifyAccountProof(APP_IDENTIFIER, proof, { fclCryptoContract: undefined }); }
  catch { return NextResponse.json({ ok: false, error: "Account proof verification failed" }, { status: 401 }); }
  if (!valid || typeof proof.address !== "string") return NextResponse.json({ ok: false, error: "Invalid account proof" }, { status: 401 });
  const provenA = proof.address.toLowerCase();
  let linked: string[] = [];
  if (claimed !== provenA) {
    const { data: ld, error: lErr } = await supabase.rpc("get_all_linked_addresses", { addr: provenA });
    if (lErr) return NextResponse.json({ ok: false, error: lErr.message }, { status: 500 });
    linked = (Array.isArray(ld) ? ld : []).map((a: string) => String(a).toLowerCase());
  }
  if (claimed !== provenA && !linked.includes(claimed)) {
    return NextResponse.json({ ok: false, matched: false, error: "not_linked", hint: "That wallet isn't HybridCustody-linked to the wallet you signed with — use the listing challenge instead." }, { status: 403 });
  }
  // verify_wallet_via_fcl only UPDATEs an existing saved_wallets row -> ensure W saved (idempotent, service_role).
  // CONFIRM the onConflict target + columns against app/api/profile/saved-wallets/route.ts before merging.
  await supabase.from("saved_wallets").upsert({ user_id: user.id, wallet_addr: claimed }, { onConflict: "user_id,wallet_addr", ignoreDuplicates: true });
  const { data: verified, error: vErr } = await supabase.rpc("verify_wallet_via_fcl", { p_user_id: user.id, p_wallet_addr: claimed, p_method: "hybrid_custody_link" });
  if (vErr) return NextResponse.json({ ok: false, error: vErr.message }, { status: 500 });
  if (!Array.isArray(verified) || verified.length === 0) {
    return NextResponse.json({ ok: false, matched: false, error: "not_saved", hint: "Save this wallet first, then verify." }, { status: 409 });
  }
  await awardPoints(user.id, "link_wallet", claimed);
  return NextResponse.json({ ok: true, matched: true, addr: claimed, via: claimed === provenA ? "self" : "hybrid_custody_link" });
}

ITEM 3 — UI button
Add a "Verify via linked wallet (read-only)" option beside the listing-challenge + FCL options in the verify surface (dashboard saved-wallets card / rewards onboarding). Reuse the FCL connect + accountProof flow already in components/SignInWithDapper.tsx (mint a nonce from /api/auth/fcl-nonce, fcl.authenticate with the accountProof service, then POST { wallet_addr: <the saved wallet being verified>, accountProof } to /api/profile/verify-link). Copy, mirroring TSCR: "Connect read-only — we never ask you to sign a transaction." On 403 not_linked, show a one-line fallback to the listing challenge.

SECURITY (must hold — this is the gate the rewards redemptions depend on)
- proof.address is the ONLY proven identity; the link must come from linked_accounts (get_all_linked_addresses), never user input. Both enforced above.
- verify_wallet_via_fcl stays SECDEF + service_role-only; user_id is requireUser()-resolved, never from the client; no amount/points arg. Re-assert grants after the CREATE OR REPLACE (Item 1).
- Do not re-grant authenticated EXECUTE on the fn or write on saved_wallets (that was the bypass closed 2026-06-08 — see docs/handoff-2026-06-08-verified-wallet-security.md + the verified-wallet-gate memory).

VERIFY / GUARDRAILS
tsc --noEmit clean; deploy READY; live anon POST /api/profile/verify-link → 307 /login (auth-gated). Authenticated happy path: a wallet linked to your signed address verifies (+500 link_wallet once); an unlinked wallet → 403 not_linked. Direct-to-main, no branches/PRs; PowerShell git on Windows; re-verify push rev-list = 0. Ledger: log the verify_wallet_via_fcl method migration + commit. CC's file inspection wins over this doc.
