# Handoff 2026-06-10 — PINFMV-DRIFT-14 is a guard bug, not an FMV leak: fix the smoke drift guard + resolve NEXTJS-14

## Context

Cowork root-caused the Sentry HIGH carried since 06-08 (JAVASCRIPT-NEXTJS-14 "Pinnacle FMV not borrowed across characters (drift guard)", ~22 events, deterministic re-trip). THE QUEUED FIX WAS AIMED AT THE WRONG HALF: the ledger/overnight item said to re-key searchPinnacleDeals onto render_id — but searchPinnacleDeals ALREADY reads floor_ask + fmv_usd from the same pinnacle_catalog row (render-keyed since a9f86af; verified by direct file read of lib/concierge/pinnacle-router.ts L115-174). The concierge route logic is CORRECT and needs no change.

The real bug is in the VALIDATOR. app/api/smoke-test/route.ts (drift guard, ~L1185-1201) builds its comparison Set from: .from("pinnacle_catalog").select(triples).not("fmv_usd","is",null).limit(5000). Supabase PostgREST clamps ANY explicit limit to the 1,000-row server max — and pinnacle_catalog now has 1,806 priced renders (counted 2026-06-10). So ~806 renders silently fall out of catalogTriples, the SAME ones every tick (stable arbitrary scan order) → every deal row whose render lives in the truncated tail flags as a "leak" → deterministic re-trip. Cowork SQL-simulated the guard against the FULL priced set: every current priced Goofy deal triple is present — zero real leaks. (The repo-wide check found this is the only .limit() >= 1000 in the smoke test.)

No DB work. One file + Sentry hygiene + two doc corrections. Claude Code's direct file inspection wins over this doc on any disagreement.

## Item 1 — fix the drift guard's comparison fetch (app/api/smoke-test/route.ts ~L1185)

Replace the global .limit(5000) catalog fetch with a fetch bounded to the rows under test: collect the distinct character names from parsed.results (<= 20 rows), then
  .from("pinnacle_catalog").select("character_name, set_name, variant").not("fmv_usd","is",null).in("character_name", distinctPlayers)
Each character has far fewer than 1,000 renders, so the clamp can never truncate it again — and the fetch gets ~100x cheaper. Keep the tripleKey normalization exactly as-is (the leading-space set_name class is real and already handled). Alternative if you prefer belt-and-braces: paginate .range() pages until short page; the bounded .in() is simpler and sufficient.

Optional hardening, same commit: have the guard cross-check that the COUNT of fetched catalog rows is < 1000 (the clamp ceiling) and mark the check inconclusive rather than failed if it ever isn't — that makes this failure class impossible to reintroduce silently.

## Item 2 — Sentry + ledger hygiene (after one clean smoke tick)

- Resolve JAVASCRIPT-NEXTJS-14 with regression arming.
- Ledger: PINFMV-DRIFT-14 -> RESOLVED, root cause "guard comparison-set truncation (PostgREST 1000-row clamp on .limit(5000)), NOT an FMV leak; searchPinnacleDeals was already render-keyed". The queued render_id-keying work item is MOOT — strike it so the night pass stops carrying it.

## Item 3 — doc corrections (2 lines)

- CLAUDE.md "General rules": the line "PostgREST caps at 1000 rows — use .limit(10000) or RPCs for larger reads" is WRONG on the .limit() half — explicit limits above 1,000 are clamped by the server max-rows. Correct it to: "PostgREST caps reads at 1000 rows and CLAMPS explicit .limit() above that — paginate with .range() or use an RPC for larger reads."
- If docs/overnight/focus.md or the morning digest still lists PINFMV-DRIFT-14 as a route-fix item, annotate it resolved per Item 2.

## Verification

npx tsc --noEmit clean; deploy READY; next smoke tick shows the drift guard passing with a result_count and no leak_count; Sentry NEXTJS-14 quiet thereafter (regression-armed). Smoke suite otherwise unchanged.

## Revert

git revert the commit (guard returns to the truncated fetch; harmless but noisy).

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- maxDuration cap 800s. CRLF: full-file writes or findIndex on split lines.
- Run the smoke test after deploy (it is the thing being fixed — watch its own tick).

## End state

One small commit on main: the drift guard compares against a complete, bounded set; NEXTJS-14 resolved with arming; the phantom "Pinnacle FMV leak" disappears from the carried queue; CLAUDE.md stops recommending a limit that doesn't work.
