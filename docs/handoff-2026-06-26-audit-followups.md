# Handoff — 2026-06-26 full-platform-audit follow-ups (Claude Code)

Source: [docs/audits/full-platform-audit-2026-06-26.md](audits/full-platform-audit-2026-06-26.md) (the full audit + findings). Platform is GREEN; these are refinements + the AllDay/Pinnacle parity work. Read on desktop; normal markdown.

## Already shipped live from Cowork (do NOT redo)
- **`audit_20260626_widen_wallet_usernames_unresolved_all_collections`** — widened `wallet_usernames_unresolved(p_limit)` candidate source from `collection='nba_top_shot' AND source='onchain'` to **all collections + all sources** (21-day sale buyers/sellers). Verified: returns 200 candidates (all previously-excluded non-TS-onchain), `check_secdef_anon_execute_violations()` `[]`, no timeout. The existing `/api/cron/resolve-wallet-usernames` cron now feeds on the platform-wide pool. **Revert:** re-add `where collection='nba_top_shot' and source='onchain'` to both legs of the `candidates` CTE.

This is the *enabling* half of the username fix (item 1 below is the throughput half).

---

## P1 — user-visible / explicit asks

### 1. Username resolver throughput (follow-on to the shipped DB widening)
**Why:** the candidate pool just grew from TS-onchain-only to all collections, so there's a one-time backlog (hundreds of previously-unreachable wallets). At `BATCH=150`/run it drains slowly.
**Where:** [app/api/cron/resolve-wallet-usernames/route.ts](../app/api/cron/resolve-wallet-usernames/route.ts) — `const BATCH = 150` (L28), `REQUEST_INTERVAL_MS = 200` (L29), `maxDuration = 120` (L32). At 200ms/req, 150 = ~30s; room to raise to ~300 (≈60s) safely.
**Do:** bump `BATCH` to ~300; confirm the cron-job.org entry for this route fires at least hourly (operator). Watch `pipeline_runs` `pipeline='wallet-username-resolver'` (`resolved`/`missed` per run) + the proxy for 429s.
**Revert:** `BATCH` back to 150.
**Verify:** buyer/seller @username share on any AllDay edition's Recent Sales climbs over a few days (was ~38% buyers / 48% sellers).

### 2. Pinnacle "Parallel Printings" ladder (the only parallels gap)
**Why:** parallels are captured correctly everywhere (TS split + laddered; AllDay/Golazos/UFC have no on-chain parallel axis — confirmed). Pinnacle's variants ARE pre-split (each `variant_type` = its own `pinnacle_catalog` render row with its own FMV), but the edition page never shows siblings.
**Where:** [app/(collections)/[collection]/edition/[slug]/page.tsx](../app/(collections)/[collection]/edition/[slug]/page.tsx) — `fetchSubeditionSiblings()` (L309) early-returns `[]` unless the external_id matches `/^\d+:\d+(::\d+)?$/` (TS int-pair), so Pinnacle gets no ladder. The ladder render (L750-787) and `SubeditionSibling` shape (L150-159) are already generic.
**Do:**
- New SECDEF read-only RPC `get_pinnacle_variant_siblings(p_edition_key text)` returning the `SubeditionSibling` shape (`external_id, subedition_id→null, subedition_name→variant, circulation_count→total_minted, thumbnail_url, fmv_usd, confidence, is_self`). **Group siblings by the same character+set+printing across `variant`** — NOT by `pinnacle_editions.edition_key` alone. The clean source is `pinnacle_catalog` (one row per `render_id`, carries `variant`, `total_minted`, `fmv_usd`, `fmv_confidence`, `thumbnail_url`, `character_name`, `set_name`, `printing`, `shape_render_id`). Confirm whether `shape_render_id` (or `character+set+printing`) is the correct sibling key before shipping — get it right so you don't show unrelated variants.
- In the page: add a Pinnacle branch so `subSiblings` is populated from the new RPC when `isPinnacle`; the existing `hasParallelLadder`/render block then works unchanged. The sibling `href` must resolve to each variant's edition page (the `edition_key` slug, e.g. `WDAS-OEEV1-WPFG:Embellished Enamel:1`).
**Revert:** `git revert` the page change + `DROP FUNCTION get_pinnacle_variant_siblings`.
**Verify:** Eeyore `WDAS-OEEV1-WPFG:Embellished Enamel:1` shows its sibling variants (Standard, Golden, …) with per-variant FMV.

### 3. AllDay badge parity (infra-blocked — needs an egress decision)
**Why:** AllDay badges exist + display but are **heuristic** — `classifyAlldayBadges` produces only 4 set-name-derived types (Rookie 728 / Playoffs 705 / Super Bowl 110 / Pro Bowl 29) vs TS's authoritative on-chain tags. (Golazos same pattern, 218 rows; UFC/Pinnacle none.)
**Blocker:** the authoritative source `nflallday.com/consumer/graphql` (`searchMomentNFTsV2`/`getMintedMoment`) Cloudflare-403s worker/edge egress — the same WAF block behind the 389 AllDay unmapped sales. The current `GET_ALLDAY_EDITIONS` query in [lib/chains/flow/alldayGraphql.ts](../lib/chains/flow/alldayGraphql.ts) doesn't even request tag fields.
**Do (two-step):**
1. Determine a WAF-proof path to AllDay achievement tags: route the consumer-GQL tag query through **Vercel egress** (the AllDay resolver comment notes Vercel reaches some AllDay surfaces the worker can't), OR confirm an on-chain Cadence accessor for AllDay tags (current `lib/chains/flow/allday-edition-onchain.ts` `GET_EDITION_DATA_SCRIPT` returns none — verify against the live contract source via the Cadence MCP).
2. Once tags are reachable: replace the string-match writer in [app/api/seed-allday-badges/route.ts](../app/api/seed-allday-badges/route.ts) with a real-tag writer populating `play_tags`/`set_play_tags` (mirror [app/api/badge-sync/route.ts](../app/api/badge-sync/route.ts) `normalizeEdition`/`mergeTags`), and add NFL badge art to `badge_taxonomy.icon_url` (TS `nbatopshot.com` SVGs won't match NFL badges; until art exists they correctly fall back to text pills).
**Interim (safe, no infra):** widen the `classifyAlldayBadges` rule set in [lib/allday-badges.ts](../lib/allday-badges.ts) for more set-name patterns. Low value but improves coverage today.

### 4. Hero / montage / team-logo image priority (black-during-load)
**Why:** pack/set/team hero montages + the team logo render black for several seconds because the above-the-fold hero images queue *behind* the 100+ below-fold grid thumbnails (which already have `loading="lazy"`). Confirmed 0 *broken* images — purely load order.
**Where:** add `fetchpriority="high"` + `loading="eager"` to the hero/montage/logo `<img>`s in [components/MomentHeroMedia.tsx](../components/MomentHeroMedia.tsx), [components/entity/HeroMontage.tsx](../components/entity/HeroMontage.tsx), [components/packs/PackHeroArt.tsx](../components/packs/PackHeroArt.tsx), and the team-page logo. Keep grid tiles `loading="lazy"`.
**Verify:** set/team/pack heroes paint before the editions grid; team logo renders.

---

## P2 — FMV/Pack-EV parity (pricing logic — REVIEW before shipping)

Per the project's FMV-change discipline: these alter central pricing logic, so review the diff before merge (one-time data fixes are fine; writer-logic changes get a pass).

### 5. AllDay FMV dual-writer race + serial-residual HIGH gate
**Why:** AllDay FMV is written by BOTH `allday-fmv-populate` (`allday-gql-v1`, GQL `lowestPrice`/`averageSale`) and shared `fmv-recalc` (`1.7.0`); latest `computed_at` wins → nondeterministic. AllDay HIGH+MED is 15% vs TS 26%.
**Where:** [app/api/cron/allday-fmv-populate/route.ts](../app/api/cron/allday-fmv-populate/route.ts) → RPC `upsert_allday_marketplace_fmv`; vs [app/api/fmv-recalc/route.ts](../app/api/fmv-recalc/route.ts) (collection-agnostic, already has the AllDay Step-5d ASK fallback on `allday_edition_floor_ask`).
**Do:** retire the GQL-populate path in favor of `fmv-recalc` + Step 5d, OR port `escalateConfidence` (serial-residual HIGH gate from `lib/fmv-confidence.ts`) into `upsert_allday_marketplace_fmv`. Resolve the race either way.

### 6. Serial / #1 / perfect-serial FMV for AllDay + Pinnacle
**Why:** TS-only today; AllDay exposes `serialOne`/`lastMint`/`jerseyNumber` in its GQL and Pinnacle has per-render circulation, so the data exists.
**Where:** [app/api/cron/refresh-serial-fmv-multipliers/route.ts](../app/api/cron/refresh-serial-fmv-multipliers/route.ts) (L~34 calls `compute_serial_fmv_multipliers()` with the TS default; add an AllDay pass) + DB fns `compute_serial_fmv_power_model`/`serial_fmv_estimate` (accept non-TS collection args) + `get_moment_detail` (populate `serial_fmv` for non-TS; the edition/moment pages already render it behind `SERIAL_FMV_PUBLIC`).
**Validate** AllDay multipliers against LiveToken before publishing (per the existing comment in that route).

### 7. Golazos / UFC ASK-only FMV fallback
**Why:** both are thin and have NO ASK fallback — they only get FMV from real sales, else NO_DATA (Golazos 77 NO_DATA + 367 SALES_ONLY; UFC 314 NO_DATA). TS has Step 5/5b (badge_editions.low_ask / edition_offers), AllDay has Step 5d (allday_edition_floor_ask).
**Where:** [app/api/fmv-recalc/route.ts](../app/api/fmv-recalc/route.ts) — add a Golazos/UFC ASK_ONLY leg off whatever live-ask source exists for them (confirm a listings source first; if none, this is a no-op and should be skipped).

---

## P3 — polish

### 8. Pinnacle FMV into shared consumers
Pinnacle FMV is the platform's **best** (55% HIGH/MED) but lives in `pinnacle_catalog` (render-keyed, excluded from `fmv_snapshots`/`fmv-recalc`), so the cross-collection deal board, alerts, and serial layer silently skip it. Bridge `pinnacle_catalog` FMV into the shared shape (or build Pinnacle-aware consumers). Values need no change — only reach.

### 9. Set-page count reconciliation for multi-set names
On set pages whose `set_name` spans multiple `set_id`s/series (e.g. "Holo Icon" = 5 set_ids / 5 series / 608 editions), the header showed "EDITIONS 241 / 364 with FMV" while tier-mix said "Legendary 608" — the three counts don't reconcile (364 priced > 241 editions is impossible). Make the EDITIONS / with-FMV / tier-mix counts come from one consistent scope in the set-detail RPC + [components/entity](../components/entity) set header.

### 10. Golazos `/analytics` — remove dead Flowty Loans panels
The Loans Book / Loans tab on the analytics monolith reference Flowty loan data that's frozen/dead post-shutdown → permanently empty panels. Remove them as part of the standing Flowty teardown. (Monolith — edit carefully.)

### 11. (Optional) Pack list EV-margin emphasis
`PackTable` already caveats survivor-bias via the `depletionChip` ("🔥 X/N remain" + `POOL_DEPLETION_TITLE` tooltip) at ≥70% pool depletion — good. Optional refinement: dim/neutralize the bold green EV-margin number (currently shows e.g. 713%/1929%) on rows above ~90% depletion so the headline number matches the caveat. Also confirm the `-10000` sentinel `pack_ev` (e.g. AllDay dist 5794) never renders as a literal price on the dist page.

---

## Out of scope / known (no action)
- AllDay unmapped backlog (389) — the consumer-GQL WAF-403 (same blocker as item 3); known/quarantined, not corruption.
- TS unmapped (508) — history-backfill spike, already draining (2,370 → 508).
- Vestigial pack columns `total_minted/total_opened/total_sealed` (all 0) — unused by the UI (it reads `metadata`); sync or drop only if a future consumer needs them.
