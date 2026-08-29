# Edge-fleet staging — 2026-08-28 (deep-audit run-4 follow-up)

These 18 files are the VERBATIM deployed source of the edge functions that had no
committed source (register R21), fetched 2026-08-28 and credential-scanned twice
(redacted-report subagents + an independent grep over the staged bytes — zero
credential shapes; the 11 functions whose deployed builds DO carry hardcoded keys
were withheld entirely and are censused in R21).

⚠ THEY ARE PARKED HERE, NOT IN supabase/functions/, BECAUSE COMMITTING THEM THERE
REDDENED FOUR GUARDS (commit 2e4bbb88, reverted same hour). Landing them properly
requires, per the guards' own demands:

1. `edge-fn-drift-checker` — its "reproduces the 2026-08-07 fleet measurement"
   test pins tier-1 expectations against the live tree; adding sources changes
   the computed set, so the pin must be re-derived (the test file documents how).
2. `edge-fn-no-hardcoded-gate-keys` — bans ANY `const *KEY* = "literal"`. Two of
   these files have benign `CHECKPOINT_KEY = "<pipeline name>"` consts
   (flowty-loan-indexer, scan-storefront-events) that the guard cannot tell from
   a credential. Either the guard gains a pinned exemption, or the consts are
   renamed AND the functions redeployed (byte-identity with deployed must hold
   for the drift detector).
3. `edge-functions-have-reachable-tests-ratchet` — BUDGET 10, these add 18
   unreachable functions. Each needs reachable behaviour (import from _shared or
   mirror + register in edge-inline-copy-drift-guard) — per-function work.
4. `edge-inline-copy-drift-guard` — 2 of these hold verbatim copies of tested
   _shared exports and need pins (the failing run names them).

Value of landing them: the credential grep and drift detector cover the real
fleet instead of 60% of it. Until then, THIS copy is the rollback artifact —
e.g. classify-acquisitions/index.ts is the v37 source behind the 2026-08-28
410-stub retirement (redeploy it with verify_jwt:false to revert that).
