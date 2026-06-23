# Handoff — 2026-06-23 audit residuals (route/edge + repo-sync)

**Context.** Follow-up to the 2026-06-22 audit + the 2026-06-23 audit-fixes drain (commits `35fc464`, `9056eff8`; READY). Re-audit confirmed everything held: AllDay ASK_ONLY 1→629, Pinnacle ASK_ONLY 640/NO_DATA 1, images 15→0 on the 2020-Finals pack, holding-pack suppressed, health 0/0/0/0 + trust 9/9. This handoff covers what Cowork **could not** ship (route/.tsx, edge-fn, data-gated) plus repo-sync for two migrations Cowork shipped **live** this session.

**Shipped live by Cowork this session (need repo-sync only — item 5):**
- `audit_20260623_pinnacle_ask_only_cover_null_confidence` — extended `pinnacle_fmv_recalc_render_all`'s ASK_ONLY pass to cover NULL-confidence renders with a floor (`OR c.fmv_confidence IS NULL`) + a final NULL→NO_DATA pass. Result: Pinnacle NULL-confidence **269→0** (157 ASK_ONLY, 112 NO_DATA); max ASK_ONLY FMV $9,000 (cap holds); fmv_sanity 0; ACL postgres+service_role.
- `audit_20260623_revoke_dormant_anon_dml_defense_in_depth` — revoked anon INSERT/UPDATE/DELETE on the 147 tables (436 grants) where anon held the grant but no anon/public write policy exists (RLS already blocked them). anon write grants **482→46**; intentional anon-write tables preserved; security invariants `[]`.

**Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.**

---

## 1. Edition "SCANNING THE MARKETPLACE…" latency (HIGH — flagship CX)

**Root cause.** On `app/(collections)/[collection]/edition/[slug]/page.tsx`, the entire below-hero detail (Current FMV, Floor, Ask, Best Offer, and the Special-Serials block) is gated behind one client-side live-marketplace fetch and shows the `components/ui/LoadingState.tsx` "SCANNING THE MARKETPLACE…" state until it resolves. That fetch hits the TS/AllDay proxy (live GQL), which is slow and can hang >10s (observed repeatedly; a DB-backed `/api/public/insights/*` probe returned 200 in ~1.2s in the same window, so it's the live-market path specifically, not the backend). The **FMV itself is in the DB (fast)** — only the live ask/floor genuinely need the slow fetch, yet the whole block waits.

(Caveat: I aggravated this with ~25 rapid automated navigations rate-limiting the proxy; a single real user is less likely to stall it. But the gate-FMV-behind-one-slow-fetch pattern is real and worth decoupling.)

**Fix.** Split the data dependency: render Current FMV / 24h / FMV-history / Special-Serials from the DB-backed data immediately (server-render or a fast DB endpoint), and scope the `LoadingState` to *only* the live ask/floor/best-offer sub-fields. Add a timeout + graceful fallback on the live-market fetch (e.g. 6–8s → show "—" / "live ask unavailable") so a slow proxy never blocks the FMV display. The client market-stats child component on the edition page is where the single `LoadingState` gate lives — inspect what it fetches and split it.

**Verify:** edition pages show FMV within ~1–2s even when the live ask is slow; `npx tsc --noEmit` clean; deploy READY.
**Revert:** `git revert <commit>`.

---

## 2. Residual ~1–5% broken legacy images (LOW)

**Root cause.** The `35fc464` fix added `rep_nft_id` (wmc LATERAL) to 5 entity RPCs so tiles use the working `media/<nft_id>/image` form — ~99% recovery. The residual (~5/103 on the Lakers page) is editions with **no minted moment in `wallet_moments_cache`**, so there's no `rep_nft_id` to derive and the tile falls back to the dead `assets.nbatopshot.com/editions/<set>/<uuid>` URL.

**Fix (optional).** In the tile media components (`components/MomentMedia.tsx`, `components/entity/EditionsGridPaginated.tsx`, `components/packs/PackThumb.tsx`), derive the `media/<id>/image` id from the **edition itself** (the id `components/MomentHeroMedia.tsx` uses for the working hero — likely `play_id_onchain` or a media id on the edition payload) as a fallback when `rep_nft_id` is absent, so artless-but-mintless editions still resolve. If no such id exists for these editions, accept as residual (tiny, oldest no-supply editions).

**Verify:** Lakers/Base-Set pages reach 0 broken tiles, or document the irreducible residual. `npx tsc --noEmit` clean.
**Revert:** `git revert <commit>`.

---

## 3. AllDay ASK_ONLY $10k cap is generous (LOW — pricing refinement)

**Observation.** The AllDay ASK_ONLY port (`fmv-recalc` Step 5d) uses floor × 0.90 with a flat ≤$10k troll-ask ceiling. A few high floor asks pass and read as FMV (e.g. Drake Maye Wild Card Gold $7,200, Tom Brady $6,400) that may be optimistic asks rather than true value.

**Fix (optional).** In `app/api/fmv-recalc/route.ts` Step 5d, consider a tighter/relative ceiling (e.g. cap relative to the edition's tier or recent comparable, or keep ASK_ONLY but down-weight confidence display when the floor is the only signal and is far above set-mates). Same consideration could apply to the Pinnacle pass. Minor — the flat cap already blocks the egregious trolls (Golazos $9k-class).
**Revert:** `git revert <commit>`.

---

## 4. Pack opened/unopened counts (data-gated — investigate, don't force)

**Status.** The "Packs Content Remaining" panel only renders for the ~14 TS packs whose `pack_distributions.metadata` carries `total_pack_count`/`remaining_by_tier`, written by `compute-topshot-pack-ev` (v20+). The counts come only from the TS GQL `getPackListing.packListingContentRemaining`, which exists only for **currently-listed packs with unopened supply (~60 of 802)**; historical/sold-out packs have no supply source. `pack_rips` is too sparse per-dist to substitute (dist 5822 = 4 traced opens vs ~17,652 actual). The dist page already hides the panel when counts are absent (correct).

**Action.** In `supabase/functions/compute-topshot-pack-ev/index.ts` (+ `compute-allday-pack-ev`), confirm whether the supply call can be widened beyond currently-listed packs (a different Dapper Studio supply endpoint), or document that historical pack counts are genuinely unavailable and leave the graceful-hide. Edge fn deploys via Supabase MCP `deploy_edge_function`.

---

## 5. Repo-sync the two live migrations (bookkeeping)

Cowork shipped the two migrations above **live**; commit their SQL to the repo migrations dir for parity (the nightly pass won't touch files committed in the last 24–48h, so do this explicitly). No behavior change — just repo↔DB parity. Both are listed in `docs/overnight/ledger.md` candidates if you log them.

---

## Guardrails
- Direct to `main`. No branches, no PRs. PowerShell `git`; re-verify push `git rev-list --count origin/main..HEAD` → 0.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`. Vercel Pro `maxDuration` cap 800s.
- CRLF: full-file writes, no string-replace patches.
- Run smoke + confirm deploy READY before done.

## Expected end state
Item 1 (the one with real user impact) shipped: edition FMV renders in ~1–2s decoupled from the live-ask fetch. Items 2–4 are optional polish/data-gated; item 5 is repo parity for the two already-live migrations. Health stays 0/0/0/0, trust 9/9.
