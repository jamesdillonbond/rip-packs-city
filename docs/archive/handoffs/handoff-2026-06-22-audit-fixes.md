# Handoff — 2026-06-22 Cowork full-platform audit fixes

**Context.** This packages the route/.tsx + reviewed-pricing fixes from the 2026-06-22 Cowork audit (`docs/audit-2026-06-22-cowork-full-platform.md`). Cowork shipped **nothing** live this session — two candidate DB ships (a traced-opened-pack-counts view; an AllDay special-serials view) were investigated and rejected after verification (pack_rips per-dist coverage too thin; `allday_moment_serials` only 64 rows / `special_serial_holders` empty). Current prod HEAD at audit time: `75ee62f` (READY). Platform green: security 0/0/0/0, trust 9/9, Sentry 1 known-transient (`NEXTJS-1Q`).

Skim `docs/overnight/ledger.md` before starting — items 1 and 7 below overlap the known `moment-hero-media-404-series1` thread; reconcile rather than duplicate.

**Claude Code's direct file inspection wins over this doc (and over `project_knowledge_search`) on any disagreement — adapt to the actual file shape.** Paths below were grep-verified to exist, but the exact edit lines are described by behavior, not patched.

---

## 1. Legacy-edition broken images (HIGH — most visible) 

**Root cause (measured).** 9,058 of 17,318 TS editions store `thumbnail_url` on `https://assets.nbatopshot.com/editions/<set_slug>/<uuid>`, and the legacy/oldest ones (2020 NBA Finals Series 1, Metallic Gold Series 1, etc.) **404** on that path. The oldest AllDay set (Genesis) has the same problem. Newer editions on the same pattern resolve, so it scales with edition age. Live evidence: pack dist 468 "What's Inside" = 15/30 broken tiles; set/team montages 10–15 broken; edition grids on Series-1-heavy sets 10–15 broken. The **edition hero already works** (`components/MomentHeroMedia.tsx`) because it uses the `assets.nbatopshot.com/media/<id>/image` pattern — the broken surfaces are the **tile** components that render `editions.thumbnail_url` raw.

**Files (grep-verified):** `components/MomentMedia.tsx`, `components/entity/EditionsGridPaginated.tsx`, `components/packs/PackThumb.tsx`, `components/packs/PackHeroArt.tsx`, `components/entity/TeamHero.tsx`. Compare against the working `components/MomentHeroMedia.tsx`.

**Fix (pick the lower-risk path):**
- **Preferred — component `onError` fallback.** In the tile media components, on `<img>`/`<video>` error, swap to the working `media/<id>/image` pattern (the same URL `MomentHeroMedia` builds). This needs the edition's media id; confirm what `MomentHeroMedia` uses (likely `play_id_onchain` or a media id already in the edition payload). Reuse that builder so tiles match the hero. This fixes all surfaces at once and is reversible by removing the `onError` handler.
- **Alternative — data backfill.** If a deterministic working URL exists for the 9,058 `editions/` rows, a one-time `UPDATE editions SET thumbnail_url=…` is a one-time data fix (allowed). **Verify the replacement resolves (HTTP 200) on a sample of 5 old editions before any bulk UPDATE** — do not bulk-rewrite to an unverified pattern. Revert = restore from a pre-update snapshot of `(id, thumbnail_url)`.

**Verify:** `curl -s -o /dev/null -w "%{http_code}" <sample old edition thumbnail_url>` → 404 today; after fix, the pack dist 468 page and `/nba-top-shot/set/base-set` render with 0 broken tiles. `npx tsc --noEmit` clean.

**Revert:** `git revert <commit>` (component path), or restore the column snapshot (data path).

---

## 2. Pinnacle per-item page 404s (HIGH)

**Root cause.** `app/pinnacle/moment/[id]/page.tsx` `notFound()`s for every id tested — the catalog `edition_id` (`2156`) and a real minted moment NFT id (`111050675472028`) both 404. The lookup key the page uses doesn't match either the `pinnacle_catalog.edition_id`/`render_id` or the `wallet_moments_cache.moment_id` for Pinnacle. Title renders the generic "Pinnacle edition" then the body bails. Net: Pinnacle has **no reachable per-item surface** (its `pages` registry in `lib/collections.ts` also lacks `edition`/`set`).

**File (grep-verified):** `app/pinnacle/moment/[id]/page.tsx` (and whatever RPC/query it calls — inspect to find which key it expects). Cross-check against how `pinnacle_catalog` (PK `render_id`, also `edition_id`, `legacy_edition_key`) and `wmc` Pinnacle rows are keyed.

**Fix.** Make the page resolve a Pinnacle item by the id that's actually linked to from Pinnacle surfaces (decide the canonical key — `render_id` is the catalog PK and is what FMV/floor hang off). Decode the param (Pinnacle render_ids/edition keys can contain `:` and need `decodeURIComponent`, same class as the `fe96d4b` Pinnacle colon-id bug and the `bf3f4f6` edition-slug decode fix). Confirm what links into `/pinnacle/moment/…` today and key off that.

**Verify:** `/pinnacle/moment/<valid render_id or linked id>` returns 200 with character/set/FMV; `npx tsc --noEmit` clean; deploy READY.

**Revert:** `git revert <commit>`.

---

## 3. Pack opened/unopened counts on only 14 packs (HIGH for the packs ask)

**Root cause.** The "Packs Content Remaining" panel (donut + per-tier depletion) on `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` reads `pack_distributions.metadata` (`total_pack_count`/`total_unopened`/`remaining_by_tier`), which `compute-topshot-pack-ev` (v20+) writes — but only **14 of 1,968 TS packs (0.7%)** and **0 AllDay/Golazos** have it. The dedicated columns `total_minted/total_opened/total_sealed/depletion_pct` are **100% empty**. `pack_rips` is too sparse per-dist to substitute (dist 5822 = 4 traced opens vs ~17,652 actual), so this is **not** a DB rollup — it's about the on-chain pack-supply query succeeding for more dists.

**File:** `supabase/functions/compute-topshot-pack-ev/index.ts` (and the AllDay sibling `compute-allday-pack-ev`). Investigate **why the supply/remaining-by-tier write only lands for 14 packs** — likely the Top Shot pack-supply API only returns counts for active/recent drops, or the call is gated/capped. Determine whether older dists can be backfilled from a different supply source.

**Lower-effort interim (page-side, `pack/dist/[distId]/page.tsx`):** where `metadata` counts are absent, the panel is hidden — that's correct (don't fake zeros). The improvement is purely upstream coverage. If broad supply data is genuinely unavailable for old packs, consider surfacing a **"packs opened (traced): N"** line from `pack_rips`/`pack_purchases` *only where N is materially complete* — but per the audit, that's rarely the case, so prefer fixing supply coverage.

**Verify:** count of TS dists with `metadata->>'total_pack_count' IS NOT NULL` rises well above 14 after a compute sweep. Edge fn deploys via Supabase MCP (`deploy_edge_function`).

**Revert:** redeploy the prior edge-fn version.

---

## 4. AllDay "Holding Pack" garbage data (MED)

**Root cause.** 17 AllDay distributions whose title matches `Hold`/`Holding` (e.g. dist 5730 "NFL Pack Hold - Genesis") carry **Pack Price $999,999 · Gross EV up to $900,000 · 3% FMV coverage**. These are holding/placeholder constructs, not consumer packs, and look broken on the dist page even with the "EV is a floor" caveat.

**Fix (two layers):**
- **Display (route/.tsx):** in `pack/dist/[distId]/page.tsx`, suppress an absurd pack price (e.g. ≥ $100,000 or a known sentinel) — render "—" instead of "$999,999", same spirit as the existing reward-pack `retail_price_usd=0` handling.
- **Data-hygiene (DB, reviewable):** exclude Hold/Holding dists from any ranked pack-EV board / pack-sniper surface so a $900K "pack" can't top a public ranking. This is a presentation filter on the board view, not an EV-formula change — but confirm the exact backing view (`topshot_pack_ev_targets` is TS-only; find the AllDay/board equivalent) and add `AND title NOT ILIKE '%hold%'` with a revert path. Keep the dist pages reachable; just stop ranking them.

**Verify:** dist 5730 page no longer shows $999,999; no Hold/Holding dist appears on a public pack board. `npx tsc --noEmit` clean.

**Revert:** `git revert` (display); inverse `CREATE OR REPLACE VIEW` (board filter).

---

## 5. AllDay ASK_ONLY from live floor asks (MED — the cleanest FMV parity win)

**Root cause / opportunity.** AllDay surfaces only **26** ASK_ONLY editions vs TS's 1,579, while **617 of AllDay's 2,271 NO_DATA editions have a live floor ask** in `allday_edition_floor_ask`. TS already does this in `fmv-recalc` Step 5b (ASK_ONLY = `low_ask × 0.90` from `badge_editions`) — the blessed, LiveToken-vindicated pattern.

**This is pricing-writer logic — do NOT ship without the mandatory LiveToken-validation gate** (memory: `fmv-livetoken-crosscheck-findings`). AllDay floor asks include troll/moonshot asks (cf. Golazos $9,000 Estrellas), so an outlier guard is required (don't promote a single absurd ask to "FMV").

**File:** `app/api/allday-fmv-populate/route.ts` (the `allday-gql-v1` writer) — add an ASK_ONLY fallback that reads `allday_edition_floor_ask` for editions with no qualifying recent sale, applies the same `× 0.90` haircut + an outlier ceiling, and writes `confidence='ASK_ONLY'`. Mirror the TS Step 5b logic exactly. Validate a sample of ~20 against LiveToken before enabling.

**Verify:** AllDay ASK_ONLY count climbs from 26 toward ~600; spot-check 10 editions against LiveToken; `v_fmv_sanity_flags` stays 0; `npx tsc --noEmit` clean.

**Revert:** `git revert <commit>`; the next `allday-fmv-populate` tick reverts the affected editions to NO_DATA.

---

## 6. Pinnacle NO_DATA-with-price label (LOW)

**Root cause.** 675 of 684 `pinnacle_catalog` rows with `fmv_confidence='NO_DATA'` carry a non-null `fmv_usd` (the floor-ask fallback). Contradictory label — should be `ASK_ONLY`, matching TS semantics.

**File:** the Pinnacle FMV writer `pinnacle_fmv_recalc_render_all()` (run by `app/api/cron/pinnacle-sync/route.ts`). When the price is floor-ask-derived (no sales), label `ASK_ONLY` not `NO_DATA`. A one-time relabel UPDATE would be re-clobbered by the daily writer, so fix the writer. **DB/pricing-writer change — keep it a label fix only, no price change.** Low user impact today since Pinnacle items aren't reachable (fix #2 first).

**Verify:** `SELECT count(*) FROM pinnacle_catalog WHERE fmv_confidence='NO_DATA' AND fmv_usd IS NOT NULL` → trends to ~0 after a `pinnacle-sync` run.

**Revert:** `CREATE OR REPLACE FUNCTION` back to the prior body.

---

## 7. Special-serials owner username resolution (LOW)

**Root cause.** On the edition page Special-Serials widget, the #1 owner renders truncated `0xc579…9f95` while the same wallet resolves to `@JJLSmith` in Recent Sales on the same page. The owner cell isn't running the `wallet_usernames` lookup (which is healthy — 3,022/3,168 resolved).

**File:** the edition page special-serials block (`app/(collections)/[collection]/edition/[slug]/page.tsx`) and/or the RPC feeding it (`get_edition_special_serials` / `topshot_special_serial_owners`) — apply the same address→username resolution used by the recent-sales rows. Also check `app/special-serial-owners/page.tsx` (the board) for the same gap.

**Verify:** the #1 owner on `/nba-top-shot/edition/243:8274` shows `@JJLSmith`. `npx tsc --noEmit` clean.

**Revert:** `git revert <commit>`.

---

## 8. Targeted anon-DML REVOKE — defense-in-depth (LOW, DB)

Not a live hole (`check_public_security_invariants()` = `[]`), but 482 anon INSERT/UPDATE/DELETE grants exist on RLS-on base tables. For top-tier posture, REVOKE anon DML on tables that don't need it — **targeted, not bulk**: keep anon INSERT on `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` (CLAUDE.md "Deferred hardening"). Generate the list with the catalog query in the audit doc §1, review each, then `REVOKE` per table with an explicit re-`GRANT` revert. Ship from Cowork as a reviewed migration if preferred.

---

## Guardrails (every handoff)

- **Direct to `main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via **PowerShell `git`** (Git Bash `git commit` can silently no-op). Re-verify the push: `git rev-list --count origin/main..HEAD` → expect `0`.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** — higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows — full-file writes or `findIndex` on split lines.
- Run the smoke test after deploy; verify Supabase row counts + Vercel READY before considering done.

## Expected end state

8 issues addressed across ~5 commits on `main` (items 1–4, 7 are the high-visibility ones), each deploy READY, with: 0 broken tiles on Series-1 pack/set pages, Pinnacle items reachable, the opened/unopened panel covering far more than 14 packs, no $999,999 AllDay packs, and (after LiveToken validation) AllDay ASK_ONLY climbing from 26 toward ~600.
