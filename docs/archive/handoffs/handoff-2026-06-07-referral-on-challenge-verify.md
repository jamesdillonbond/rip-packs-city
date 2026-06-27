# Handoff — referral credit on listing-challenge verification (small) — 2026-06-07

PLAIN TEXT (iPhone copy-paste). No triple-backticks. Claude Code's direct file inspection wins on any disagreement. Direct to main, no branches/PRs. Push anything pending first (explicit-path staging).

================================================================
CONTEXT
================================================================
Gap: referral_verified only fired on the Dapper-MINTED fcl-verify path — which is dead for normal Top Shot users (Dapper sign-in needs developer access). A referred TS collector signs up via magic link and verifies via the LISTING CHALLENGE, so the referrer never got credited. Without this, the referral flywheel never pays for the main user population.

Already shipped live DB-side (Cowork, audit_20260607_referral_on_challenge_verify_and_quest_hold):
- resolve_wallet_challenge_match now takes an optional 4th arg p_referrer uuid DEFAULT NULL. Server-side guards live in the function: referral pays ONLY when this is the user's FIRST-ever verified wallet, p_referrer <> the user, and p_referrer exists in user_profiles. Existing 3-named-arg calls keep working (the default applies) — but Item 1 wires the real value through.
- Also: the weekly_quest earn rule was set inactive (no quest mechanism exists yet — the /rewards earn list reads it from points_rules, so it disappears automatically; nothing to do, just FYI. Reactivate with a real quest system later).

The referral plumbing that already exists client-side (from commit 830bfdb): RefCapture stashes ?ref=<referrer-user-id> into localStorage 'rpc_ref'; SignInWithDapper sends it as body.ref and clears it on minted success.

================================================================
ITEM 1 (the whole job) — pass the stored ref through the challenge check
================================================================
Files: the verify modal's check call in app/dashboard/page.tsx + app/api/profile/verify-challenge/check/route.ts.

1a. Client: when the modal POSTs the check endpoint, include ref from localStorage:
  ref: (typeof window !== "undefined" && localStorage.getItem("rpc_ref")) || undefined
  On a successful verification response, clear it: try { localStorage.removeItem("rpc_ref") } catch {}
  (Same pattern SignInWithDapper already uses — keep them consistent.)

1b. Route: read body.ref; accept it ONLY if it's a well-formed uuid (/^[0-9a-f-]{36}$/i after trim), else treat as absent. Pass it to the RPC as p_referrer alongside the existing named args. Do NOT add any other trust logic in the route — the DB function owns the guards (first-verification-only, no self-referral, referrer must exist). Surface referral_award from the RPC result in the response if present (the UI can ignore it).

Verification: a fresh account opening ?ref=<real-user-id>, verifying via the listing challenge -> referrer +300 appears in the rpc-rewards-console ledger (reason referral_verified). Re-verifying a second wallet on the same account -> NO second referral (first_verification=false). Anon POST -> 401/redirect (unchanged). tsc clean; deploy READY.

Revert: remove the ref field from the client call + the p_referrer pass-through (git revert the commit). DB revert (only if abandoning): re-create resolve_wallet_challenge_match without p_referrer.

================================================================
END STATE
================================================================
One small commit. Referrals pay out on the path real Top Shot users actually take: share link -> friend signs up -> friend verifies by listing -> referrer +300, exactly once, server-guarded.
