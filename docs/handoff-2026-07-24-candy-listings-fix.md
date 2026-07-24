# Handoff — candy-listings-indexer bug fix (ME limit) + invariant-drift ledger note

**Date:** 2026-07-24 · **Author:** Cowork · **For:** Claude Code (Trevor's machine)

## Context

Post-ship verification of the A–E parity build turned up one real bug and one cosmetic drift I already fixed live. The parity views/boards are otherwise healthy (special-serials 500, holders 246, players 100, spread 29, deals/floor correctly 0, parallel 2). Two things for you below (one route fix + one ledger line), plus an optional hardening note.

## Item 1 — BUG: `candy-listings-indexer` fails every run (ME `limit=500` → HTTP 400). Route fix → you.

- **Symptom:** the first scheduled run (2026-07-24 18:35 UTC) logged `ok:false, listings_found:0, sweep_complete:false` in 247 ms. It will fail on **every** tick, so `candy_listings` never fills and the whole deals/spread/floor family stays empty. (This is NOT the reported "clean no-op under quest-hold.")
- **Root cause:** `app/api/candy-listings-indexer/route.ts` line 40 — `const ME_LIMIT = 500`. Magic Eden's `/v2/collections/{symbol}/listings` caps `limit` low; `limit=500` returns **HTTP 400**, so `fetchListings()` throws at the `if (!resp.ok)` guard (line 65) and the catch block logs `ok:false`.
- **Evidence (verified live 2026-07-24, symbol `2026_mlb_base_series_icons_candy_digital`):**
  - `…/listings?offset=0&limit=20` → **200**, 15 live listings (e.g. Bo Bichette 222/250 @ 0.0285 SOL).
  - `…/listings?offset=0&limit=500` → **HTTP 400**.
  - So listings EXIST right now; the indexer just can't read them at the oversized page size.
- **Fix:** set `ME_LIMIT = 20` (proven working; ME caps this endpoint at 20). Because pages are now smaller, raise `MAX_PAGES` (line 41) from 40 to ~200 so `ME_LIMIT × MAX_PAGES` (4,000) comfortably exceeds the active-listing count — otherwise a large book exits the loop with `sweep_complete:false` (no short/empty page) and skips deactivation. Optional: test `limit=100` first; if ME accepts it, use that and keep `MAX_PAGES` smaller.
- **Verify:** manual-invoke the route (or wait for the next `:35` cron) →
  - `pipeline_runs` latest `candy-listings-indexer` row = `ok:true, sweep_complete:true, listings_found ≈ 15`;
  - `SELECT count(*) FROM candy_listings;` > 0;
  - `candy_deals_board` / `candy_listing_floor` / `candy_offer_spread_board` populate.
- **Revert:** `git revert` the fix commit (restores 500 — don't).

## Item 2 — Ledger line for a live migration Cowork already applied (safe, verified). Add to ledger → you.

Cowork applied `audit_20260724_candy_view_invoker_normalize` live via MCP: `ALTER VIEW … SET (security_invoker=on)` on the 11 Candy views that were created with `security_invoker=true`. Postgres stores the literal `=true`, which `check_public_security_invariants()` doesn't match (it tests `reloptions @> ARRAY['security_invoker=on']`), so all 11 tripped `view_unexpected_definer` — benign (they ARE invoker + anon-revoked, no leak), but it left the invariant permanently dirty. After normalization the invariant returns `[]` (verified) and grants are unchanged (anon/authenticated still `SELECT`-revoked on all 12 candy views, verified).

**Ledger entry to add (newest-at-top):**
```
2026-07-24 — audit_20260724_candy_view_invoker_normalize (Cowork, live via MCP) — normalized 11 candy views security_invoker=true→on so check_public_security_invariants() reads clean again (was 11 benign view_unexpected_definer rows; all invoker + anon-revoked, no leak). Verified [] + grants unchanged. Revert: ALTER VIEW <v> SET (security_invoker=true) ×11 — NOT recommended, =on is the codebase convention.
```

## Item 3 — OPTIONAL hardening (edits security machinery → owner call, low priority)

`check_public_security_invariants()` recognizes only `security_invoker=on`, not the equally-valid `=true`, so any future view created with `WITH (security_invoker = true)` will false-positive as `view_unexpected_definer`. Consider widening the containment test to accept both spellings so this can't recur. It edits the SECDEF invariant function, so it's a careful/owner change — low priority now that the `=on` convention is restored across the Candy views.

## Guardrails

Direct to `main`, no branches. PowerShell `git`; re-verify push with `git rev-list --count origin/main..HEAD` (expect 0). `npx tsc --noEmit` clean + Vercel READY. Log Item 1 to `docs/overnight/ledger.md` with its revert path (and add the Item 2 line). **Claude Code's direct file inspection wins over this doc — confirm the line numbers before editing.**

## End state

`candy-listings-indexer` returns `ok:true` and captures the live Magic Eden asks → `candy_listings` fills → deals/spread/floor come alive (timely, listings are live now ahead of Drop 3). Invariant stays clean. Everything still gated; `candy_mlb` still `is_active=false`.
