# Handoff — FMV recalc-pipeline fixes (reviewed)  ·  2026-06-02

Source: the 2026-06-02 LiveToken accuracy audit ([docs/audits/fmv-livetoken-accuracy-2026-06-02.md](audits/fmv-livetoken-accuracy-2026-06-02.md)) + a design/adversarial-verify workflow (8 agents, run `wf_24fe97e4-b65`). Each of the 4 recommendations got a design spec AND an independent adversarial verifier that re-ran the SQL and read the actual code. **The verifiers found material problems in 3 of 4 specs — the corrected guidance below reflects the verifier findings, not the raw optimistic specs.**

**Status: NONE of this is auto-shippable.** This is FMV pricing logic — off-limits for the autonomous pass, and the audit's own rule (memory `fmv-pipeline-patch-restraint`) says deliver as a reviewed handoff. Several items also need a Trevor product call (flagged inline). Ship via Claude Code on `main`, dry-run + verify each.

## Priority (by real-user value-at-risk × shippability)

Real-user prioritization comes from the internal confidence-exposure audit across 10 seeded wallets (2026-06-02): on **$50+ TS holdings, almost nothing is HIGH/MEDIUM (0–3 per wallet) and LOW dominates the value-at-risk** (e.g. mbl267 $47.5K on LOW; per-wallet "% value at risk" 22–83%). So:

1. **STALE display safety** — ship first (high trust win, mostly render-layer, ship-with-changes).
2. **LOW reliability** — ship second (the single biggest value-at-risk; ship-with-changes).
3. **NO_DATA low-circ** — small actual win; rework + reframe.
4. **ASK_ONLY multiplier** — premise was wrong; redesign at the haircut layer.

---

## 1. STALE display safety  ·  ship-with-changes  ·  highest confidence

**Problem.** STALE snapshots render their stale last-traded $ at face value across the platform (worst case: Wembanyama Metallic Gold LE `166:5978` shows $949.67 at 44d since sale vs ~$113 real). ~161 displayable TS + ~474 AllDay editions carry the STALE label; weighted by holdings, **363 distinct STALE editions are held across 11,430 wmc rows totaling ~$370K** of stale FMV flowing into portfolio/share/dashboard totals with no signal.

**This is overwhelmingly a render-layer fix. Do NOT write a decayed value into `fmv_snapshots`** — keep the honest STALE label + last value in the data; qualify at the render boundary so history charts stay intact. (Editions that remain STALE almost never have a usable ask to decay toward — recalc already converts those to ASK_ONLY at the source: TS 3/161, AllDay 112/496.)

**Code changes (render):**
- `components/entity/_shared.tsx` — add a canonical `<StaleAwareFmv value confidence />` + `staleFmvText()` next to the existing `isStaleConfidence` / `STALE_FMV_TOOLTIP`. Muted + dotted-underline + "no sales in 30+ days" tooltip, labelled "Last $X (stale)" not "Current FMV". Every surface falls back to this one primitive.
- `app/(collections)/[collection]/edition/[slug]/page.tsx` — "Current FMV" StatCell → "Last FMV (stale)" via the primitive; promote the existing ask cell (`highOffer.low_ask ?? fmv.cross_market_ask`) as the headline price hint when present.
- `components/entity/EditionsGridPaginated.tsx` — tile FMV (`~L154`) via the primitive (grids already return `confidence`).
- `app/moment/[id]/page.tsx` — hero FMV + the JSON-LD `offers.price` (see open question).
- `app/share/[wallet]/page.tsx` + `app/dashboard/page.tsx` — consume the new confidence fields; mute STALE rows; footnote the hero total.
- `app/api/og/edition/route.tsx` + `app/api/og/moment/[id]/route.tsx` — OG cards have no tooltip; **suppress/relabel** the stale $ ("Last $X" / "No recent sale").
- `components/MomentDetailModal.tsx` — confirm it receives `confidence`; thread from the parent row if not.

**The one data-layer change** (`get_wallet_collection_snapshot` is confidence-blind — feeds the /share hero, topMoments, rarest, perCollection): LATERAL-join `wmc → editions → latest fmv_snapshots` to attach confidence; exclude STALE from `totalFmv`/perCollection and add a `staleFmvExcluded` footnote field + per-moment `confidence`. Same signature, superset jsonb shape (backward-compatible). Latency measured fine (+~198ms on Trevor's 14k-moment wallet; the existing ~1459ms is jsonb aggregation, not the new join).

**⚠️ Verifier-required corrections (do these or it breaks/overclaims):**
- **Grant inventory is wrong in the spec.** `get_wallet_collection_snapshot` is granted EXECUTE to **anon + authenticated + service_role + postgres** (it backs the anon `/share` funnel), NOT service_role-only. `CREATE OR REPLACE` preserves grants — so either change nothing, or explicitly `GRANT EXECUTE ... TO anon, authenticated, service_role`. **Do NOT re-grant service_role-only** (would strip anon and break /share). Capture all four in the rollback note.
- **Pinnacle is out of scope, not "closed."** Pinnacle editions live in `pinnacle_editions` (text keys), so the `editions.external_id = wmc.edition_key` join misses 100% of Pinnacle rows → NULL confidence → never excluded. Benign **today** because `pinnacle_fmv_snapshots` emits no STALE. Document as an explicit non-goal + add tripwire: `SELECT count(*) FROM (SELECT DISTINCT ON (edition_id) confidence FROM pinnacle_fmv_snapshots ORDER BY edition_id, computed_at DESC) x WHERE confidence::text='STALE'` must stay 0.
- Pick ONE render policy and reconcile the collection monolith (`collection/page.tsx` already mutes-but-shows the $). Recommendation: **muted last-known $ + tooltip on interactive surfaces; full suppression only on OG cards.**

**Open product calls (Trevor):** (a) totalFmv exclude STALE + footnote (implemented) vs include-with-footnote — exclude lowers everyone's headline number; (b) JSON-LD `offers.price` on /moment for STALE: drop (loses rich-result price) vs keep last-known.

---

## 2. LOW reliability  ·  ship-with-changes  ·  biggest value-at-risk

**Problem.** ~6,315 displayable TS LOW editions = 71% of priced displayable TS. LiveToken proved LOW is unreliable in BOTH directions (−89% to +317%). This is the core FMV-quality weakness and (per the wallet exposure audit) the largest real-user value-at-risk.

**Lever A — widen the confidence sample for thin-sales editions.** In `app/api/fmv-recalc/route.ts` Step 1b/2/4: when `sales_count_30d < MIN_SALES_30D_HIGH (7)`, feed `escalateConfidence()` a wider (90d) sales sample (count + prices + serials) so the serial-residual gate can grade honestly instead of defaulting to the volume-floor LOW. Editions that flunk SD≥0.35 **stay LOW** (the demotion ceiling is preserved — and now reached for more editions, which is stronger honesty). No change for healthy ≥7-in-30d editions.

**Lever B — ask-anchor stuck-LOW editions (new Step 5c).** 466 TS editions carry a 1.7.0 LOW snapshot, have a fresh `badge_editions.low_ask` (0<ask≤10000), and **no real sale in 30d** — Step 5b never reaches them (it only fires on non-1.7.x latest snapshots). Relabel them ASK_ONLY at `low_ask*0.90`. Verifier confirmed **non-redundant** (450 are ≤$200 below the guard floor; the 16 >$200 have stale `sales_count_30d<>0` so the DB guard's `sales_count_30d=0` gate never fires).

**⚠️ Verifier-required corrections:**
- **fmv_usd must match the label.** As specced, `fmv_usd` stays on the 30d recency-weighted WAP while the HIGH/MEDIUM label is earned on the 90d sample → it can stamp **HIGH on a price backed by a single 30d sale** (less honest than the LOW it replaces). Fix: when an edition is escalated off the widened sample, **price `fmv_usd` from that same widened, outlier-filtered, recency-weighted sample**, OR cap the escalated label at MEDIUM while `sales_count_30d < 5`.
- **Net LOW reduction is ~797, not 1,212.** Simulating `escalateConfidence` on the 1,212: 318→HIGH, 479→MEDIUM, **415 stay LOW** (SD≥0.35). Use ~797 in any framing.
- **Two-pass fetch is a requirement, not an option.** Tripling the Step 1b scan to 90d at `DEFAULT_LIMIT=2500` risks the `after()` 300s cap (the 2026-05-24 unchunked-`.in` silent stall is the precedent). Fetch 30d first, then 60/90d top-up only for the sub-7 subset; or lower the per-run limit for the widened path.
- **Manual-backfill cursor hazard (Lever B).** A manual route POST with no `body.offset` reads + overwrites the persisted sweep cursor → can skip a swath of editions. If backfilling the 466 ahead of cron, pass an explicit `body.offset`; otherwise let the cron sweep pick them up (self-healing).
- Replicate the ULTIMATE/Pinnacle exclusion (`tier<>'ULTIMATE'`, `collection_id<>PINNACLE`) in the new Step 5c query. Pass `serials` parallel to `prices` (length mismatch silently falls back to raw CV). TS-only — `badge_editions.low_ask` is 0 for AllDay / ~5% Golazos.

**Open call:** 60d (962 editions) vs 90d (1,212) window; `1.7.0` vs `1.7.1` algo tag (1.7.1 keeps Step 5b's `NOT LIKE '1.7.%'` ownership clean and aids before/after diffing — grep for hardcoded `'1.7.0'` consumers first).

---

## 3. NO_DATA low-circ  ·  needs-rework  ·  small actual win

**Reality check (verifier).** REC 2's premise is mostly false. Of the ~408 displayable TS NO_DATA editions with `circ≤150`: 98 are ULTIMATE (owned by `recalc_ultimate_fmv`, off-limits), and **303 of the remaining 310 have zero sales ever AND no ask anywhere** — genuinely unpriceable. The actionable subset is tiny.

**What's actually worth doing:**
- The genuinely-new value (LeBron Anthology `100:3919`: $23,232 ask, stuck on a `cold-tail-1.0` NO_DATA row) is gated behind **raising the ask ceiling `<=10000` → `<=100000`**. Decide explicitly. At `<=10000` the TS rescue count is **0** (it's ~23 Golazos).
- Step 5's "NO_DATA-aware" extension **largely duplicates `drain_fmv_cold_tail`**, which already writes ASK_ONLY from `badge_editions.low_ask` (capped ≤10000) for the `sales_count_30d=0` branch. The lower-surface-area fix is to **bump `drain`'s `p_limit` / raise `drain`'s cap**, not extend Step 5. (Durability mechanism: a fresh today row makes the edition ineligible for `drain` re-touch for 7 days via `drain`'s `last_snapshot < NOW() - INTERVAL '7 days'` gate — document so a future editor doesn't break it.)
- **Do NOT add a `SALES_ONLY` 30–60d band as specced.** `applyStaleGuard` (in-route, `lib/fmv-phantom-guard.ts`) exempts only HIGH/STALE/ASK_ONLY, and the DB guard's WHERE is `fmv_usd>200 AND confidence<>'ASK_ONLY'` — so any `SALES_ONLY` row >$200 (which always has `sales_count_30d=0` here) is flipped to STALE before it's ever shown. To make SALES_ONLY real you must exempt it in **both** guards in the same change, or drop the relabel.

**The real REC 2** is a primary-data gap: a TS marketplace ask feed that reaches special/LE editions (the known badge-sync coverage gap — `searchMarketplaceEditions` can't reach KD-Supernova-class editions; `set.flowId` 0 sentinel). That's a badge-sync/edition-ask ingest task, not a recalc change. Otherwise NO_DATA is the honest label for never-traded low-circ rarities.

---

## 4. ASK_ONLY multiplier  ·  needs-rework  ·  premise was wrong

**The spec's premise is false (verifier re-ran the SQL).** There is no live flat `0.90` to "fix": the 1.7.0 ASK_ONLY thin band already realizes `fmv_usd/floor_price_usd ≈ 0.73` because **Step 8 (`fmv_apply_thin_sale_haircut`) and Step 9 (`apply_fmv_thin_sales_guard`) run AFTER Step 5/5b and write the winning, capped value.** Changing the Step 5/5b `0.90` only changes an intermediate input the haircut overrides — `0.80` of the raw ask is actually *higher* than the ~0.73 these rows realize, i.e. the change would **raise** thin-cohort FMV, the opposite of intent. Also only **653 of 842** ASK_ONLY editions are recalc-owned (1.7.0); the other 189 are written by `thin-sales-guard-v3`, `*_haircut`, `ask_only_v2`, `cold-tail-1.0` — a fmv-recalc-only change can't move them, and Step 5b's `NOT LIKE 1.7.%` selection would create a recalc↔haircut ping-pong on them every tick.

**Correct approach if we still want liquidity-adjusted ask discounting:**
- Implement the tiered curve in the **haircut/guard layer (the actual last writer)**, or make the haircut **exempt freshly-written ASK_ONLY** so the Step 5/5b multiplier survives — pick one owner of the final value.
- First **prove the direction** against the LiveToken comparison set (what was the measured overshoot magnitude on the low-liquidity cohort?). Thin rows already realize ~0.73, so a 0.80 floor is *less* conservative.
- Put the curve in a shared helper consumed by ALL ASK_ONLY writers (recalc, `drain_fmv_cold_tail`, `topshot-fmv-populate`/`ask_only_v2`, the listing-cache routes, the haircut), or accept it only partially lands.

---

## Cross-cutting invariants (all items)
- `fmv_snapshots`: latest-`computed_at`-wins, delete-then-insert (never upsert), `collection_id NOT NULL`, partitioned. No item should write outside fmv-recalc's existing delete-then-insert.
- Both stale guards must keep exempting ASK_ONLY (memory `fmv-ask-only-owned-by-recalc`). The demotion ceiling (count≥7 & residual SD≥0.35 → LOW) stays. Don't touch Step 6's fixed latest-CTE-before-filter ordering.
- Windows/CRLF null-byte mount hazard on the big files (`dashboard/page.tsx`, the collection monolith) — line-targeted patches, trust READY over local re-reads.

## Verification
Each spec carries SQL verification queries (in the workflow output `wf_24fe97e4-b65`). Minimum gates per ship: (1) re-run the population query pre/post; (2) confirm no ULTIMATE/Pinnacle row got a 1.7.x snapshot; (3) confirm no ASK_ONLY row collapsed to STALE (guard exemption intact); (4) `pipeline_runs` fmv-recalc `ok=true` post-deploy; (5) CI + smoke green + deploy READY.
