# Full Platform Audit — Rip Packs City — 2026-06-26 (Cowork)

Scope: full health check of website + database + pipelines, Chrome visual QA of entity pages (editions / packs / sets / teams) and key public surfaces, a packs deep-dive, plus a parity assessment of parallels, badges, FMV, and Pack EV across all five collections (NBA Top Shot, NFL All Day, LaLiga Golazos, UFC Strike, Disney Pinnacle).

**Verdict: platform is GREEN and in genuinely good shape.** No outages, no security holes, no broken-image epidemics, no stale data. Every page type renders with accurate data. The findings below are refinements and parity gaps, not fires. Counts/figures captured live at ~14:30 UTC 2026-06-26.

---

## 1. Platform health — GREEN

- **Security:** `check_public_security_invariants()` clean, `check_secdef_anon_execute_violations()` `[]`, `check_pgcron_recent_failures()` none. RLS posture intact.
- **Pipelines:** `detect_stalled_pipelines()` `[]`. `get_pipeline_alerts()` = 1 INFO only (`ufc_sales` resolving-editions, benign).
- **Trust health:** 8/9 OK. One standing **BREACH — `unmapped_resolution_backlog_max`** (priced sales failing edition-resolution). See §2/§7.
- **Vercel:** prod `80a9238b` READY, zero ERROR deploys (the CANCELED entries above it are docs-only commits correctly skipped by the `ignoreCommand`).
- **Sentry:** 6 unresolved, **all benign smoke-test transients** — no real user errors. Two are heavy-page smoke timeouts on `/disney-pinnacle/overview` and `/laliga-golazos/analytics`; both were verified rendering fine + fast live (the failure is the smoke deadline, not the page — see §6 perf note).
- **DB size:** 6,156 MB.

---

## 2. Data integrity by collection

### Editions
| Collection | Editions | Notes |
|---|---|---|
| NBA Top Shot | 17,470 | incl. 1,775 `::` parallel editions |
| NFL All Day | 6,191 | |
| LaLiga Golazos | 581 | |
| UFC Strike | 518 | |
| Disney Pinnacle | (separate `pinnacle_editions` / `pinnacle_catalog`, render-keyed; 15 distinct variants) | |

### FMV quality (latest-per-edition confidence)
| Collection | HIGH+MED | Share | Engine |
|---|---|---|---|
| **Top Shot** | 4,564 | **26%** | shared `fmv-recalc` 1.7.0 + `lib/fmv-confidence.ts` |
| **Pinnacle** | — | **55% HIGH/MED** | bespoke render-catalog (`render-catalog-2.0`), separate `pinnacle_catalog` table — *highest quality on the platform* |
| **AllDay** | 908 | **15%** | dual writers: `allday-gql-v1` + `fmv-recalc` 1.7.0 (race; see §6) |
| **Golazos** | 2 | ~0.3% | shared `fmv-recalc` only; mostly SALES_ONLY (367) — thin market, no ASK fallback |
| **UFC** | 15 | ~3% | shared `fmv-recalc` only; mostly NO_DATA (314) — thin market, no ASK fallback |

### Unmapped-sales backlog (the trust BREACH), open rows by collection
- Top Shot **508** — the known on-chain history-backfill spike (draining: was 2,370 on 06-25).
- NFL All Day **389** — the known `nflallday.com/consumer/graphql` Cloudflare-403 block for worker/edge egress (≈16% of V1 sales fail edition resolution).
- UFC 21, Golazos 20.
- These are quarantined OUT of `sales` (not corruption) — they're a sales *undercount*, not bad data.

---

## 3. Visual QA (Chrome, authed as jamesdillonbond)

Verified live: dashboard; 10 edition pages spanning all 5 collections (3 TS base, 2 TS parallels, 2 AllDay, 1 Golazos, 1 UFC, 1 Pinnacle); pack dist + pack list pages (TS + AllDay); a TS set page; a TS team page; Pinnacle overview; Golazos analytics; the squeeze insights board. Nav chrome + breadcrumbs render consistently on every page.

**What's working well:**
- **Heroes/data flow correctly.** Edition pages show FMV / 24h / floor / best-offer, FMV history chart, recent sales, "Found in these packs", and (TS) the **Parallel Printings ladder** + Same-Play section + badges. Example verified: Dalano Banton `90:3050::4` → "RIPPLED · /4000", per-printing FMV $0.29, badges (Top Shot Debut/Fresh/Rookie Year).
- **Pack dist pages are excellent** (see §4).
- **Insights boards are polished, public, fresh** (squeeze board: filters, stat cells, hourly refresh, no-signup).
- **No broken-image epidemic** — image audits returned 0 *broken*; the blank tiles seen are lazy-load timing, not 404s.

**Findings (severity in §7):**
| # | Surface | Finding |
|---|---|---|
| A | Edition Recent-Sales | **Buyer/seller wallets ~40–50% show raw hex** instead of @username (coverage gap, not a bug — §5). |
| B | Pack / Set / Team heroes | **Hero + montage + team logo render black during load** — they load *after* the 100+ below-fold grid thumbnails, so the most prominent visual is blank longest. Image-priority issue. |
| C | Set pages (multi-set names) | Header counts don't reconcile: e.g. Holo Icon shows "EDITIONS 241 / 364 with FMV" but tier-mix "Legendary 608". Root cause: "Holo Icon" spans **5 distinct set_ids across 5 series** and the page aggregates by `set_name`. |
| D | Pack list pages | Survivor-bias **EV margins (713%–1929%)** on near-depleted packs surface without the caveat the dist page carries; one AllDay pack carries the `-10000` sentinel EV. |
| E | Golazos `/analytics` | Chart panels empty; the **Loans Book / Loans panels reference dead Flowty data** (post-shutdown) — permanently blank. |
| F | All entity pages | "SCANNING THE MARKETPLACE…" full-page loader gates content for ~6–10s and pages eagerly load 100+ images — perceived-perf drag + the cause of the two Sentry smoke timeouts. |

---

## 4. Packs deep-dive

**The dist page is strong and already covers the user's asks.** Verified on dist `5048` ("For The Win & Denied!: Chance Hit"):
- Total/opened/unopened **displayed well**: "PACKS REMAINING 142 of 22,068 minted", "DEPLETION 99%", and a **donut chart** ("0.6% unopened · 142 / 22,068 packs") with per-tier remaining bars (Ultimate 0/2, Legendary 0/240, Rare 47/5,275, Common 663/104,823) + a Pull-Odds-by-Tier table.
- EV honesty is sharp: GROSS EV $20.64 with *"EV inflated by survivor bias (99% depleted) — honest value ≈ secondary ask $9.00"*, plus primary SOLD OUT / secondary $9.00, FMV coverage 99%.

**Data-source note (not a user-facing bug):** the dedicated columns `pack_distributions.total_minted / total_opened / total_sealed / depletion_pct` are **0 across all 5,263 distributions** — both the dist and list pages instead read the real values from `pack_distributions.metadata` (`total_pack_count`, `total_unopened`, `remaining_by_tier`). So the zero columns are **vestigial/unused**; no display is wrong because of them. (Optionally sync metadata→columns or drop them; low priority.)

**Pack EV parity:** TS 1,179 + **AllDay 521** + Golazos 224 pack rows. AllDay list page is at parity (3,052 dists, EV/coverage columns, honest "ended primary pack sales — secondary only" banner). Pinnacle/UFC have no packs (correct — neither lists a `packs` tab).

**Improvements (D, B above):** add the survivor-bias caveat (or suppress EV margin) on the *list* page for heavily-depleted packs; guard the `-10000` sentinel from rendering; fix the black pack-hero/montage by prioritizing those images.

---

## 5. Parallels — capture correctness across collections

| Collection | Parallels captured? | How | Surfaced? |
|---|---|---|---|
| **Top Shot** | ✅ Yes, correctly | `topshot_moment_subeditions` → `::subID` edition split, per-parallel circulation + de-blended FMV | ✅ "Parallel Printings" ladder on edition pages |
| **Pinnacle** | ✅ Yes (pre-split) | every variant is already its own `pinnacle_catalog` row (render_id-keyed; 15 variants e.g. Embellished Enamel, Golden, Silver Sparkle) | ❌ **No sibling ladder** — variants aren't cross-linked; only reachable as separate pages |
| **AllDay** | n/a | one `editionID` = one edition; **no on-chain parallel axis exists** | n/a (correct) |
| **Golazos / UFC** | n/a | same single-edition-per-moment model; no parallel axis | n/a (correct) |

**Answer to "are we capturing parallels correctly across all collections":** Yes. TS is fully correct. AllDay/Golazos/UFC have nothing to capture (verified — no parallel concept on-chain). The **only gap is a UX one: Pinnacle's already-split variants aren't surfaced as siblings.** That needs a `get_pinnacle_variant_siblings` RPC + an edition-page branch (the page's ladder logic currently early-returns for any non-TS-int-pair external_id).

---

## 6. Badges — AllDay vs Top Shot parity

| Collection | Source | Coverage | Display |
|---|---|---|---|
| **Top Shot** | authoritative on-chain `play.tags`/`setPlay.tags` via `badge-sync` | 9,166 rows, full tag set (Top Shot Debut, Rookie Year/Mint/Premiere, MVP/Championship Year, All-Star, 3-Star Rookie…) | real SVG art via `/api/badge-image` |
| **AllDay** | **heuristic** `set_name` string-matching (`classifyAlldayBadges`) | 1,572 rows, **only 4 types**: Rookie 728, Playoffs 705, Super Bowl 110, Pro Bowl 29 | text pills (verified: "Rookie" on Quinyon Mitchell) |
| **Golazos** | heuristic (same pattern) | 218 rows | text pills |
| **UFC / Pinnacle** | none (Pinnacle uses `is_chaser`) | 0 | — |

**Answer to "are badges captured correctly for AllDay like Top Shot":** Partially. AllDay badges *exist and display*, but they're derived from set-name keywords (4 categories), not the authoritative on-chain achievement tags TS uses. **True parity is blocked by infrastructure:** AllDay's authoritative tag source is `nflallday.com/consumer/graphql`, which Cloudflare-403s worker/edge egress (the same WAF block causing the 389 unmapped AllDay sales), and the current AllDay GQL query doesn't even request tag fields. Path to parity: route the tag query through Vercel egress (not the worker), request the tag/achievement fields, and replace the string-match writer in `seed-allday-badges` with a real-tag writer — then source NFL badge art for `badge_taxonomy` (TS SVGs won't match). Until then, the heuristic is the reasonable interim, and its rule set can be widened.

---

## 7. FMV / Pack EV parity for AllDay & Pinnacle — assessment

The user's request to "replicate FMV / Pack EV and apply what's relevant to AllDay & Pinnacle." Current state + concrete gaps:

**Pack EV:** AllDay is already at parity (521 rows, dual primary/secondary framing). Pinnacle has no packs (correct). *No work needed* beyond the list-page survivor-bias caveat (§4).

**FMV — AllDay:**
1. **Dual-writer race (correctness risk).** `allday-fmv-populate` (`allday-gql-v1`, GQL `lowestPrice`/`averageSale`) and shared `fmv-recalc` (`1.7.0`) both write AllDay FMV; latest `computed_at` wins. Resolve by retiring the GQL-populate path in favor of `fmv-recalc` + the existing AllDay ASK fallback (Step 5d), or by porting `escalateConfidence` into the GQL writer.
2. **No serial-residual HIGH gate** on the GQL path → AllDay HIGH share lags (15% vs TS 26%).

**FMV — Pinnacle:** quality is actually the *best* on the platform (55% HIGH/MED) — but it lives on an **isolated stack** (`pinnacle_catalog`, excluded from `fmv-recalc`/`fmv_snapshots`). So shared consumers (cross-collection deal board, serial-FMV, alerts) silently skip Pinnacle. Parity = build Pinnacle-aware variants of those consumers (or bridge `pinnacle_catalog` FMV into the shared shape). Pricing values themselves need no change.

**FMV — Golazos/UFC:** thin markets, and they have **no ASK fallback** (only real sales produce FMV → otherwise NO_DATA). Adding an ASK_ONLY fallback (mirror TS Step 5b / AllDay Step 5d) would lift coverage off live asks.

**Serial / #1 / perfect-serial FMV:** **TS-only today.** AllDay already exposes `serialOne`/`lastMint`/`jerseyNumber` in its GQL and Pinnacle has per-render circulation, so the data exists to extend `serial_fmv_estimate` + `compute_serial_fmv_multipliers` to both — **pricing logic, route through review** (per the FMV-change discipline).

---

## 8. Prioritized action list (engineering follow-ups)

Severity: **P1** user-visible / explicit ask · **P2** quality/parity · **P3** polish. Type flags where review is required.

| # | Item | Sev | Type | Where / how |
|---|---|---|---|---|
| 1 | **Expand username resolution to sale participants** (buyers/sellers ~40–50% raw hex) | P1 | route/edge-fn + GQL | `wallet_usernames_unresolved()` candidate set currently = tracked wallets; widen to recent `sales` buyer/seller addresses so the existing resolver cron sweeps them. (No pure-SQL backfill available — sources already synced.) |
| 2 | **Pinnacle parallel-sibling ladder** | P1 | new RPC + .tsx | `get_pinnacle_variant_siblings(render_id)` over `pinnacle_catalog` (group by character+set across variants) + branch the edition page's `hasParallelLadder` for Pinnacle |
| 3 | **AllDay badge parity** | P1 | route + data | Route AllDay consumer-GQL tag query via Vercel egress (WAF-proof), request tag fields, replace `seed-allday-badges` string-match with real-tag writer; source NFL badge art. Interim: widen `classifyAlldayBadges` rules |
| 4 | **Pack list survivor-bias EV honesty** + `-10000` sentinel guard | P1 | .tsx | Add the dist-page caveat / suppress EV margin on >90%-depleted packs; never render the `-10000` sentinel as a price |
| 5 | **Hero/montage/team-logo image priority** | P2 | .tsx | Prioritize above-the-fold hero/montage/logo images ahead of the below-fold editions grid (or lazy-load the grid) so heroes don't render black |
| 6 | **AllDay FMV dual-writer race** + serial-residual HIGH gate | P2 | pricing — **review** | Retire `allday-gql-v1` populate in favor of `fmv-recalc` + Step 5d ASK fallback, or port `escalateConfidence` |
| 7 | **Serial / #1 / perfect-serial FMV for AllDay + Pinnacle** | P2 | pricing — **review** | Extend `compute_serial_fmv_multipliers` / `serial_fmv_estimate` + `get_moment_detail` to non-TS (data already present) |
| 8 | **Golazos/UFC ASK-only FMV fallback** | P2 | pricing — **review** | Mirror TS Step 5b / AllDay Step 5d for thin markets with live asks |
| 9 | **Set-name aggregation count reconciliation** | P2 | RPC/.tsx | Make EDITIONS / with-FMV / tier-mix counts consistent when a `set_name` spans multiple set_ids/series |
| 10 | **Golazos analytics: remove dead Flowty Loans panels** | P3 | .tsx | Part of the standing Flowty teardown |
| 11 | **Pinnacle FMV into shared consumers** (deal board, alerts, serial) | P3 | DB/route | Bridge `pinnacle_catalog` FMV into the shared shape so Pinnacle stops being skipped |
| 12 | **Pack count columns** `total_minted/opened/sealed` are vestigial 0s | P3 | DB | Sync from metadata or drop (no display depends on them) |

Note: items 6/7/8 touch FMV/pricing logic and are flagged for review before shipping, per the project's FMV-change discipline (one-time data fixes are fine; central pricing logic gets a review pass).

---

## Bottom line

The site, database, and pipelines are healthy and the user-facing pages render correctly with accurate data across all five collections. Parallels are captured correctly everywhere they exist (TS split + laddered; AllDay/Golazos/UFC genuinely have none; Pinnacle pre-split but not yet cross-linked). AllDay badges and Pack EV exist and work but trail Top Shot in source quality; the badge gap is infra-blocked (AllDay GQL WAF). The most user-visible, in-scope wins are #1 (usernames), #2 (Pinnacle siblings), #3 (AllDay badges), #4 (pack EV honesty), and #5 (hero image priority).
