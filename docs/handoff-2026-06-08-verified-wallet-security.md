# Handoff 2026-06-08 — verified-wallet sybil-guard hardening (SECURITY)

Found by the HybridCustody-spec verification pass: the verified-wallet gate that protects `requires_verified_wallet` redemptions (`redeem_shop_item` checks `EXISTS(SELECT 1 FROM saved_wallets WHERE user_id=p_user_id AND verified_at IS NOT NULL)`) was bypassable by any authenticated user with zero proof. CLAUDE.md "no user-writable points path" still holds (points aren't writable) — but the verification gate in front of redemptions was. Three vectors; Cowork closed the two trivial ones live, this handoff is the third (route code) + the record.

## SHIPPED LIVE by Cowork (migration audit_20260608_close_verified_wallet_selfwrite_holes)

Verified post-apply (grants re-queried): `verify_wallet_via_fcl` EXECUTE now service_role-only; `saved_wallets` anon+authenticated retain only SELECT,REFERENCES,TRIGGER (no INSERT/UPDATE/DELETE/TRUNCATE). service_role unchanged.

- Vector (ii) CLOSED: `verify_wallet_via_fcl(uuid,text,text)` had `authenticated:EXECUTE` (the SECDEF default-grant footgun) and only guards `auth.uid()=p_user_id` — no proof inside — so any logged-in user could PostgREST-call it to self-verify any wallet. Revoked EXECUTE from authenticated/anon/PUBLIC. Verified safe: the sole caller is app/api/auth/fcl-verify/route.ts L108/L162 via supabaseAdmin (service_role), AFTER fcl.AppUtils.verifyAccountProof (grep-confirmed: no other caller, no client/authenticated-client caller).
- Vector (i) CLOSED: `saved_wallets` had GRANT ALL (INSERT/UPDATE/DELETE/TRUNCATE) to BOTH anon and authenticated, and its UPDATE RLS policy (`saved_wallets_update_own`) has no column lock — so an authenticated user could `INSERT` any wallet_addr then `UPDATE saved_wallets SET verified_at=now() WHERE user_id=<me>` (RLS allows own-row), fully bypassing proof. (authenticated TRUNCATE was an extra latent cross-tenant wipe risk — TRUNCATE isn't RLS-gated.) Revoked INSERT/UPDATE/DELETE/TRUNCATE from anon+authenticated. Verified safe: ALL legit writes go through service_role server routes (saved-wallets route uses supabaseAdmin; ZERO .tsx client writes — both grep-confirmed). SELECT kept (RLS-gated to own rows).

Revert (migration): GRANT EXECUTE ON FUNCTION public.verify_wallet_via_fcl(uuid,text,text) TO authenticated; GRANT INSERT,UPDATE,DELETE,TRUNCATE ON public.saved_wallets TO anon,authenticated;

## FOR CLAUDE CODE (vector #1 — the route still trusts body.addr; gate NOT fully closed until this ships)

File: app/api/auth/fcl-verify/route.ts (~L40–110).
Why: the route mints a single-use nonce and runs fcl.AppUtils.verifyAccountProof correctly — but the proof proves control of `proof.address`, while the wallet actually marked verified is the SEPARATE top-level `body.addr` field (passed to verify_wallet_via_fcl as p_wallet_addr at L110/L165). The honest client (components/SignInWithDapper.tsx L55-58) sets them equal, but a malicious client can submit a valid proof for a wallet it owns (X) while posting addr:Y (a whale's) and get Y verified. The two DB revokes above do NOT close this — the route itself passes the unchecked addr via service_role.
Fix (one line, do BOTH call sites): after a successful verifyAccountProof, assert the claimed address equals the proven one before any verify/award —
  if (addr.toLowerCase() !== proof.address.toLowerCase()) return NextResponse.json({ error: "Address does not match the signed account proof" }, { status: 401 });
— or simply use proof.address everywhere downstream instead of body.addr (cleanest: drop body.addr entirely). Normalize to lowercase 0x-16hex (linked_accounts + the rest of the system store lowercase).
Revert: git revert.
Verify: a proof for X with posted addr=Y → 401; honest same-address flow still verifies; tsc clean; deploy READY.

## OPTIONAL defense-in-depth (CC or Cowork, low priority)

The `saved_wallets_update_own` RLS policy still has no column lock — moot now that the write grant is revoked, but if a future migration ever re-GRANTs authenticated UPDATE (e.g. for a client-side nickname edit) the verified_at hole reopens silently. Belt-and-suspenders options when/if that happens: (a) a BEFORE UPDATE trigger that resets NEW.verified_at/verification_method to OLD unless current_user='service_role'; or (b) column-level grant excluding those two columns. Not needed today; documented so a future grant change doesn't reintroduce the hole.

## FUTURE (HybridCustody build — see docs/features/hybrid-custody-verify-path-2026-06-08.md)

When that path is built, `verify_wallet_via_fcl` rejects unknown methods: `IF p_method NOT IN ('fcl_dapper','fcl_blocto','fcl_other') THEN RAISE`. Add 'hybrid_custody_link' to that IN-list (one line). CREATE OR REPLACE resets grants → re-assert service_role-only (NOT authenticated — that's the hole just closed).

## Ledger
Add audit_20260608_close_verified_wallet_selfwrite_holes to docs/overnight/ledger.md Shipped block with the revert above (Cowork didn't edit the ledger — repo-doc mount truncation hazard).

GUARDRAILS: direct-to-main, no branches/PRs; PowerShell git on Windows; re-verify push with git rev-list --count origin/main..HEAD = 0. Claude Code's direct file inspection wins over this doc on any disagreement.
