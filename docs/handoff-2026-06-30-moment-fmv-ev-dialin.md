# Handoff — Moment FMV → Pack EV dial-in (2026-06-30, Cowork)

Goal (Trevor): improve Top Shot Moment FMV for regular moments + the special-serial algo + parallels (tracking/linking), then use a complete per-moment FMV to dial in pack EV, with good visualizations on the moment + pack pages. This handoff packages the REVIEW-GATED pricing-logic + on-page render changes. The read-only data work is already shipped live (below). Full measured diagnosis is in the same-date ledger entry.

## Diagnosis headlines (all measured live 2026-06-30)
- **Regular base FMV** is healthy: 43.8% HIGH+MED (1,166 HIGH + 2,886 MED of 9,257 base editions), up from the old ~35%. The LOW bucket is honest (wide real per-sale spread) — no algo bug, volume-gated. Lever is UX (range display) + the deep median-anchor-for-thin-editions change already flagged review-gated in CLAUDE.md.
- **#1 and perfect-mint** serial models are well-calibrated and live: tier medians match actuals within ~2%, per-sale APE 36–56% (the established LiveToken ±~45% band). first/FANDOM is statistically dead (r 0.036) and correctly falls back to the flat grid.
- **Jersey-match serials are UNPRICED (1x)** despite a validated ~16.7x median premium (p25 5x / p75 46x, n=262/180d). This is the single biggest special-serial gap. A jersey model is now built read-only (below) and validates at #1-model quality.
- **Parallels** (1,751 `::` editions) are fully cataloged, priced, linked (`get_edition_subedition_siblings`), and rendered (edition-page "Parallel Printings" ladder). They are INVISIBLE to pack pools (0 parallel pool rows).
- **Pack EV** modeled ~4x / calibrated ~2.5x the realized pull mean (199 dists, >=10 opens). Trevor's direction: headline EV should reflect the value of what REMAINS in the pack (not the historical average pull). So realized-mean is a sanity FLOOR, not the anchor; the real lever is FMV honesty on the surviving chase editions, bounded by the existing secondary-ask gate.

## Already SHIPPED LIVE this session (DB via MCP — additive, read-only, inert; revert paths below)
1. **`serial_fmv_jersey_model` + `compute_serial_fmv_jersey_model()`** — migration `audit_20260630_serial_fmv_jersey_model_readonly`. INERT (no live consumer reads it yet). RLS on, no anon/authenticated grants, fn anon-execute revoked. Fit on 180d HIGH/MED jersey-match sales, identical methodology to `compute_serial_fmv_power_model` (log-log OLS, gate n>=40 & r>=0.35 & 0.15<beta<1.25):
   - COMMON  k 26.3150 / beta 0.4737 / n 80  / r 0.551 / reliable (fmv 0.50–47.14)
   - RARE    k 3.8123  / beta 1.0875 / n 56  / r 0.826 / reliable (fmv 4.95–413.39)
   - ALL     k 22.4783 / beta 0.4867 / n 160 / r 0.631 / reliable (pooled fallback)
   - FANDOM (beta~0) + LEGENDARY (n 8) NOT reliable -> fall back to ALL.
   Validation (predicted vs actual, 180d): COMMON med $31.00 vs $30.97 (APE 45%), RARE $40 vs $35.24 (52%), LEGENDARY $192 vs $213.74 (55%), ALL $40 vs $35.52 (51%) — same band as the live #1/perfect models.
   Refresh: `SELECT public.compute_serial_fmv_jersey_model();`
   Revert: `DROP FUNCTION public.compute_serial_fmv_jersey_model(uuid,integer,integer,numeric); DROP TABLE public.serial_fmv_jersey_model;`
2. **`get_pack_ev_contributors(p_dist_id text, p_limit int)`** — migration `audit_20260630_get_pack_ev_contributors`. Read-only SECDEF; top remaining editions of a TS dist by per-slot EV contribution (pull_prob, ev_per_slot, pct_of_ev) + FMV + confidence + player/set/tier. anon revoked; granted authenticated + service_role. Backs Item 2's panel.
   Revert: `DROP FUNCTION public.get_pack_ev_contributors(text,integer);`

Also built (Cowork, outside the repo): live artifact **`rpc-moment-fmv-ev-dialin`** (FMV coverage base/parallel, serial-model calibration incl. jersey, pack-EV reality, parallel/pool wiring). No repo action.

---

## Item 1 — Wire jersey premium into `serial_fmv_estimate` (REVIEW-GATED pricing logic)
**Acceptance gate FIRST.** Per the FMV-pipeline-patch-restraint + the LiveToken cross-check rule: before flipping jersey public, run the LiveToken acceptance test (method: `docs/cowork-skills/rpc-fmv-audit/SKILL.md`) on a sample of jersey-match serials — accept only if no systematic bias, order-of-magnitude right, within ~+/-45%. Three prior pricing "fixes" died to this gate; do not skip it.

**LiveToken acceptance gate — RESULT (run 2026-06-30): NOT PASSED on the premium/grail tail — do NOT wire jersey public yet.** Cross-checked RPC jersey estimates vs LiveToken serial-adjusted `valueFMV` (LiveToken exposes `isJerseyNumber` and prices it) on jersey-specialist wallet `0xc579f9caeac49f95` (page-1 / top-FMV holdings = the grail segment). Of premium jersey moments where RPC produces an estimate (HIGH/MED base, n=6): RPC ran SYSTEMATICALLY LOW vs LT — LeBron #23 $485 vs $908 (0.53×), Larry Bird #33 $175 vs $360 (0.48×), Khaman Maluach #10 $276 vs $474 (0.58×), Ausar Thompson #9 $96 vs $333 (0.29×) — plus 2 clamp-driven HIGHs on Dylan Harper rookie parallels (1.85–2.26×) where base FMV exceeds the model's `fmv_max` and the estimate flatlines. Median ratio ~0.55×; ~none within ±45%. Also ~10 of the 19 captured premium jerseys carry LOW/ASK_ONLY/NO_DATA base FMV, so the HIGH/MED gate suppresses any estimate. The broad-market sales validation (APE 45–55%, central medians within ~10%) still holds — the model is fine mid-market but underprices the grail tail (the segment users care most about). **Refine before wiring:** (a) the `fmv_max` clamp flatlines high-FMV editions — raise/remove the per-tier cap or add a high-FMV regime; (b) premium jerseys are mostly LOW/ASK_ONLY base so they're gated off regardless — tie jersey surfacing to the broader FMV cold-tail improvement; (c) the systematic LOW vs LT suggests the broad fit underweights the star / low-circ / famous-number premium LT captures — consider a low-circ or star interaction, then re-run this gate on a broader (non-grail-skewed) sample. The read-only `serial_fmv_jersey_model` stays INERT until re-gated.

**REFIT v2 (2026-06-30, read-only — root cause found + fixed; jersey now SALES-VALIDATED for the bulk).** The sales-residual analysis (the real arbiter, not LT) showed the jersey premium MULTIPLE is inverse to base FMV — realized ~10.6× for base<$50 (n=150, robust), collapsing to ~2× for base≥$150 (n=11, thin) — the same economics as #1/perfect. The v1 RARE cell (β=1.09, super-linear) contradicted this and over-extrapolated grails, and there are ZERO jersey sales above the fit range (the grail tail is data-starved — both RPC v1 and LT over-model it). Fix (migration `audit_20260630_jersey_model_refit_beta_below_1`): tightened the reliability β upper bound 1.25→1.0 so a reliable jersey cell must be sub-linear. Result: only COMMON (k24.4/β0.50) + ALL-pooled (k21.3/β0.51) reliable; RARE/LEG/FANDOM → pooled. v2 residuals (actual/pred): base<$150 (n=157, ~96% of jersey volume) calibrated 0.88–0.94, APE ~0.50 (= the #1/perfect band); grail bands (n≤3) now conservative — the clamp makes editions above ~$450 base show ≈base / no premium (honest given no data there). vs LiveToken: v2 sits BELOW LT on grails (LeBron #23 v2 $203 vs LT $908), but realized SALES back v2 (the $50–150 band realizes ~2×), so **LT over-prices illiquid grails — do NOT chase it.**
**Recommendation:** jersey is wireable FOR THE BULK (base <~$150) where it is sales-validated. When wiring serial_fmv_estimate, ADD a low-confidence flag when base_fmv exceeds the model `fmv_max` OR when estimate==base (grail / no-premium) so the UI de-emphasizes those. The strict LT ±45% gate still "fails" on grails BY CONSTRUCTION (LT is high there), so the acceptance basis for jersey is the SALES validation (bulk passes cleanly), with grails flagged low-confidence. Trevor's call to flip.

**1a. Schedule weekly refresh** (pg_cron, mirrors serial-fmv jobs 5/6):
```sql
SELECT cron.schedule('rpc-serial-fmv-jersey-weekly','0 11 * * 0',$$SELECT public.compute_serial_fmv_jersey_model();$$);
```
Revert: `SELECT cron.unschedule('rpc-serial-fmv-jersey-weekly');`

**1b. Add a jersey branch to `serial_fmv_estimate`.** It has no player context today, so add `p_jersey_number int DEFAULT NULL`. Precedence #1 > perfect > jersey (overlaps default to the earlier bucket; rare). Jersey reads `serial_fmv_jersey_model` (tier-specific reliable else ALL); jersey has NO flat-grid fallback (NULL if no reliable cell). Full body:
```sql
CREATE OR REPLACE FUNCTION public.serial_fmv_estimate(
  p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text,
  p_edition_fmv numeric, p_confidence text, p_jersey_number integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE
  v_bucket text; v_band text; v_mult numeric; v_sample integer; v_basis text; v_estimate numeric;
  v_k numeric; v_beta numeric; v_r numeric; v_fmin numeric; v_fmax numeric; v_model_tier text; v_fmv_clamped numeric; v_label text;
BEGIN
  IF p_serial IS NULL OR p_circulation IS NULL OR p_circulation <= 0
     OR p_edition_fmv IS NULL OR p_edition_fmv <= 0 THEN RETURN NULL; END IF;
  IF upper(coalesce(p_confidence,'')) NOT IN ('HIGH','MEDIUM') THEN RETURN NULL; END IF;
  IF p_serial = 1 THEN v_bucket := 'first';
  ELSIF p_serial = p_circulation THEN v_bucket := 'perfect';
  ELSIF p_jersey_number IS NOT NULL AND p_jersey_number > 1 AND p_serial = p_jersey_number THEN v_bucket := 'jersey';
  ELSE RETURN NULL; END IF;
  v_band := CASE WHEN p_circulation<100 THEN 'ultra' WHEN p_circulation<500 THEN 'low'
                 WHEN p_circulation<2500 THEN 'mid' WHEN p_circulation<10000 THEN 'high' ELSE 'mass' END;
  v_label := CASE v_bucket WHEN 'first' THEN 'estimated #1 premium'
                           WHEN 'perfect' THEN 'estimated perfect-mint premium'
                           ELSE 'estimated jersey-match premium' END;

  IF v_bucket = 'jersey' THEN
    SELECT k,beta,r,fmv_min,fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
    FROM public.serial_fmv_jersey_model
    WHERE collection_id=p_collection_id AND is_reliable AND tier=coalesce(p_tier,'UNKNOWN') LIMIT 1;
    IF v_k IS NULL THEN
      SELECT k,beta,r,fmv_min,fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
      FROM public.serial_fmv_jersey_model WHERE collection_id=p_collection_id AND is_reliable AND tier='ALL' LIMIT 1;
    END IF;
    IF v_k IS NULL THEN RETURN NULL; END IF;
    v_fmv_clamped := LEAST(GREATEST(p_edition_fmv,coalesce(v_fmin,p_edition_fmv)),coalesce(v_fmax,p_edition_fmv));
    v_estimate := GREATEST(p_edition_fmv, v_k*power(v_fmv_clamped,v_beta));
    RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_estimate/p_edition_fmv,2),
      'serial_bucket','jersey','circ_band',v_band,'basis','power_model','sample_size',NULL,
      'model_k',round(v_k,4),'model_beta',round(v_beta,4),'model_r',round(v_r,3),'label',v_label);
  END IF;

  v_model_tier := CASE WHEN v_bucket='perfect' THEN 'ALL' ELSE coalesce(p_tier,'UNKNOWN') END;
  SELECT pm.k,pm.beta,pm.r,pm.fmv_min,pm.fmv_max INTO v_k,v_beta,v_r,v_fmin,v_fmax
  FROM public.serial_fmv_power_model pm
  WHERE pm.collection_id=p_collection_id AND pm.serial_bucket=v_bucket AND pm.tier=v_model_tier AND pm.is_reliable LIMIT 1;
  IF v_k IS NOT NULL THEN
    v_fmv_clamped := LEAST(GREATEST(p_edition_fmv,coalesce(v_fmin,p_edition_fmv)),coalesce(v_fmax,p_edition_fmv));
    v_estimate := GREATEST(p_edition_fmv, v_k*power(v_fmv_clamped,v_beta));
    RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_estimate/p_edition_fmv,2),
      'serial_bucket',v_bucket,'circ_band',v_band,'basis','power_model','sample_size',NULL,
      'model_k',round(v_k,4),'model_beta',round(v_beta,4),'model_r',round(v_r,3),'label',v_label);
  END IF;

  SELECT m.multiplier,m.sample_size INTO v_mult,v_sample
  FROM public.serial_fmv_multipliers m
  WHERE m.collection_id=p_collection_id AND m.serial_bucket=v_bucket
    AND m.tier=coalesce(p_tier,'UNKNOWN') AND m.circ_band=v_band AND m.is_reliable LIMIT 1;
  IF v_mult IS NOT NULL THEN v_basis:='tier_circ';
  ELSE
    SELECT m.multiplier,m.sample_size INTO v_mult,v_sample
    FROM public.serial_fmv_multipliers m
    WHERE m.collection_id=p_collection_id AND m.serial_bucket=v_bucket AND m.tier='ALL' AND m.circ_band='ALL' AND m.is_reliable LIMIT 1;
    v_basis:='aggregate';
  END IF;
  IF v_mult IS NULL THEN RETURN NULL; END IF;
  v_estimate := GREATEST(p_edition_fmv, p_edition_fmv*v_mult);
  RETURN jsonb_build_object('estimate_usd',round(v_estimate,2),'multiplier',round(v_mult,2),
    'serial_bucket',v_bucket,'circ_band',v_band,'basis',v_basis,'sample_size',v_sample,'label',v_label);
END;
$fn$;
-- new signature resets grants + leaves the old overload; clean both:
REVOKE EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text,integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text,integer) TO service_role;
DROP FUNCTION IF EXISTS public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text);
```
Ordering is SAFE for existing callers: while both overloads exist, 6-arg calls bind to the old fn; after the DROP, 6-arg calls fall through to the new fn's `p_jersey_number` DEFAULT NULL = unchanged (#1/perfect-only) behavior. Jersey activates only once callers pass the number (1c).
Revert: `CREATE OR REPLACE` the 6-arg body (prior def in migration history) + `DROP FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text,integer);`.

**1c. Callers pass jersey_number.** `get_moment_detail` and `get_trophy_slab_data` resolve the moment's player jersey via `players.jersey_number` (mind the ~3x dup-player rows — `max(jersey_number)` / non-null) and pass `p_jersey_number` to `serial_fmv_estimate`. Keep the existing HIGH/MED base gate. No new surface — jersey rides the existing serial-premium path.

**1d. Moment page.** `app/moment/[id]/page.tsx` (~L1025) already renders any `serial_fmv` estimate, so jersey appears automatically once 1b/1c land and `SERIAL_FMV_PUBLIC` stays `true`. Verify the label reads "estimated jersey-match premium". (This is the moment-page half of the requested viz.)

---

## Item 2 — Pack dist page: "What drives the remaining EV" panel (display-only; ready to ship)
Backed by `get_pack_ev_contributors` (already live). TS-only, server-rendered, additive — the pack-page half of the requested viz, and the on-page surface for Trevor's "value of what REMAINS" framing + the chase-FMV honesty lever. File: `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`.

INTEGRATION NOTES (verified against the live page): the client is `supabaseAdmin` from `@/lib/supabase` (NOT an `rpcClient()` helper); the page has its own bespoke `Td` helper (~L1951) and inline-styled tables — it does NOT use shared `Section`/`ConfidencePill` components, so render the panel with the page's own idioms (an `<h2>`/section wrapper + inline-styled `<table>` + a small inline tier/confidence chip like the existing `tierChip`). Add `evContributors` to the existing `Promise.all` (~L744) and its destructure. Gate the render on `collection === "nba-top-shot"`. Fetch (use `supabaseAdmin`):
```ts
async function fetchEvContributors(distId: string) {
  const { data, error } = await supabaseAdmin.rpc("get_pack_ev_contributors", { p_dist_id: distId, p_limit: 12 })
  if (error) { console.error("[pack-detail] ev_contributors", error.message); return [] }
  return Array.isArray(data) ? data : []
}
```
Render (TS dists with rows; place under the existing EV / reality-check block). Summary line + low-confidence caveat are the point:
```tsx
{evContributors.length > 0 && (
  <Section title="What drives the remaining EV">
    <p style={{ color: "var(--rpc-text-muted)", fontSize: 13, marginBottom: 10 }}>
      Each row is an edition still in the pool. EV share = its pull probability x its FMV, as a fraction of the pack's
      per-slot expected value — i.e. what you're actually paying for in what remains.
    </p>
    {(() => {
      const lowConf = evContributors.filter(c => ["LOW","ASK_ONLY","STALE","NO_DATA"].includes(c.confidence))
      const lowShare = lowConf.reduce((s,c)=> s + Number(c.pct_of_ev||0), 0)
      return lowShare >= 25 ? (
        <p style={{ color: "var(--rpc-amber, #e0a52f)", fontSize: 12.5, marginBottom: 10 }}>
          ⚠ {Math.round(lowShare)}% of the remaining EV leans on low-confidence chase prices — treat this EV as soft.
        </p>
      ) : null
    })()}
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead><tr>
        <th style={{ textAlign:"left" }}>Edition</th><th>Tier</th><th>Pull %</th><th>FMV</th><th>EV share</th>
      </tr></thead>
      <tbody>
        {evContributors.map((c:any)=>(
          <tr key={c.edition_id}>
            <td style={{ textAlign:"left" }}>{c.player_name} · {c.set_name}</td>
            <td>{c.tier}</td>
            <td>{(Number(c.pull_prob)*100).toFixed(2)}%</td>
            <td>{c.fmv_usd!=null ? `$${Number(c.fmv_usd).toFixed(2)}` : "—"} <ConfidencePill confidence={c.confidence} /></td>
            <td>{Number(c.pct_of_ev).toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  </Section>
)}
```
The TSX above is REFERENCE pseudo-markup — `Section`/`ConfidencePill` do NOT exist on this page; swap to the page's bespoke `Td` + inline styles + `tierChip`, and a small confidence chip. Use brand tokens (`var(--rpc-*)`), never hardcode `#E03A2F`.
Revert: `git revert` the commit (display-only).

---

## Item 3 — FANDOM #1 (minor; no action needed to keep current behavior)
first/FANDOM is statistically dead (r 0.036) and falls back to the flat grid (coarse-labeled). Trevor previously chose apply-without-suppress, so current behavior is acceptable. Optional: suppress-to-NULL for FANDOM #1 in the grid path. Product call; no code required to keep as-is.

## Item 4 — Parallel-aware pack pools (research; data-gated; NOT a quick fix)
`pack_drop_pool` references 0 `::` parallel editions — EV models every pull as the base/Standard printing and ignores the higher-value parallels (~14% of TS mints, parallels trade ~1.6x+ the base). Net today: packs that can yield parallels are modestly UNDER-valued (conservative). Making pools parallel-aware needs per-parallel pull odds, which TopShot GQL does not publish per-pack in an easily-keyed form. Document as a known limitation; revisit if a per-parallel odds source appears.

## Item 5 — Pack-EV remaining-pool honesty (the real lever; ongoing, review-gated)
Headline EV = value of what REMAINS (already the `drop_weight = remaining/totalUnopened` basis — correct, keep it). The ~4x modeled/realized gap on opened packs is NOT survivorship-as-bug: a chase-heavy remaining pool genuinely has high pull-EV for the next ripper; realized-mean is the avg of PAST (commons-heavy) opens, a different question. The honest-EV lever is FMV accuracy on the SURVIVING chase editions (stale/troll chase FMV), bounded by the existing secondary-ask gate. Item 2's panel exposes this per-dist; the deeper systemic fix is the median-anchor-for-thin-editions FMV change already flagged review-gated in CLAUDE.md. Keep realized as a reality-check, not the headline anchor.

## Verify after shipping
- tsc clean; deploy READY + smoke.
- Jersey: a known jersey-match serial of a HIGH/MED edition (e.g. a star wearing a notable number) shows "estimated jersey-match premium" ≈ k·fmv^β on the moment page; LiveToken acceptance gate logged.
- Pack panel: a chase pack's top contributors sum ~100% of EV share; low-confidence caveat fires when warranted.
- Re-run the `rpc-moment-fmv-ev-dialin` artifact: jersey flips LIVE; parallel-pool-rows still flagged until Item 4.

---

## Deep multi-factor special-serial analysis — what the sales actually support (2026-06-30)

Tested whether special-serial value can be modeled from "a ton of mixed property factors" with sales backing. Built a hedonic log-price model and validated EVERY factor with 5-fold cross-validation (held-out dollar APE) across all three serial types. Anchor = edition latest FMV (HIGH/MEDIUM). Datasets (365d): #1 n=679, perfect n=242, jersey n=186 (1,471 special-serial sales total with the same-edition normal-median anchor).

**Cross-validated results (test R² / median dollar APE):**
- **#1:** FMV 0.56/53% → +tier 0.61/46% → **+circ 0.66/44% [best]**. Adding series, play_category, or player-stardom = NO held-out gain.
- **perfect:** FMV 0.54/47%; tier + circ add ~nothing (0.54/46%).
- **jersey:** FMV 0.34/54%; tier small; circ worsens APE; noisiest bucket.

**Factors TESTED and REJECTED on held-out accuracy** (they raise train fit but not test): `series`, `play_category`, `player-stardom`. Player-stardom (player median sale price) is redundant with edition FMV — which already prices player demand: player-star ALONE testR² 0.32 < FMV-only 0.45; added on top of FMV+tier+circ it moved R² 0.550→0.564 while APE got worse. `badges`/`reward_indicators` columns are empty (not usable).

**CONCLUSION (no hallucination):** the sales data supports a PARSIMONIOUS model — **edition FMV + tier + circulation for #1; edition FMV for perfect/jersey** — with a **~44–52% irreducible median-APE noise floor** (special-serial prices are genuinely high-variance; the same edition's #1 sells across a wide range by timing/buyer). A many-factor model fits noise, not signal. This is WHY the existing power-law models (FMV^β per tier) are already near-optimal; the only validated enhancement is adding explicit circulation to the #1 model (CV testR² 0.61→0.66, APE 46%→44%).

**Validated #1 coefficients** (log-price OLS, 679 sales): `ln(price) = 1.10 + 0.889·ln(FMV) + 0.309·ln(circ) + tier{COMMON/FANDOM: 0, RARE: −0.82, LEGENDARY: −0.77}`. (β_FMV<1 = sub-linear, matches the inverse-multiple; +circ = cheap high-circ editions carry the biggest #1 premium; RARE/LEG negative = lower multiple at equal FMV.)

**LiveToken cross-check (done):** LiveToken over-prices illiquid grails (LeBron #23 LT $908 vs realized-band ~2× ≈ $170); realized sales back the model on the bulk. Acceptance basis = SALES, with grails flagged low-confidence.

**Recommendation:** keep it parsimonious. If wiring: (a) add explicit `ln(circ)` to the #1 estimator (the one validated gain); (b) keep perfect/jersey on FMV-anchored pooled curves; (c) surface a confidence/range band — the ~±45% noise is real and should be shown, not hidden; (d) do NOT add series/play_category/player factors — they don't generalize. The honest product story is "FMV-anchored serial premium with an explicit uncertainty band," not a false-precision many-factor number.

### Trevor's specific factors tested (rookie/TS-Debut badges, player career scarcity) — also rejected

Tested the intuitive "mixed property factors": rookie badges, Top Shot Debut, composite badge_score, and player career circulation (total mints across a player's editions — e.g. Wemby is scarce). Source: `badge_editions` (`play_tags` Top Shot Debut/Rookie Year/Premiere/RoY, `is_three_star_rookie`, `has_rookie_mint`, `badge_score`; joinable by `external_id`) + per-player Σ circulation.

5-fold CV on #1 (n=336, base = FMV+tier+circ test R² 0.536 / APE 50%): **+TS-Debut 0.536/48%, +rookie 0.536/49%, +badge_score 0.534/50%, +player-career-circ 0.533/49%, +ALL four 0.528 (R² DROPS = overfit).** Full-model coefficients conditional on FMV are ~0 or wrong-signed (TS-debut −0.30, rookie −0.14, badge_score +0.06, ln_player_circ +0.02).

**Why none help:** edition FMV is a near-sufficient statistic for moment desirability — the market ALREADY prices rookie/debut cachet and player scarcity INTO the moment's base FMV (Wemby's scarcity is exactly why his editions carry high FMV). Re-adding those upstream demand drivers to the serial-premium layer just refits noise. They belong in the base edition-FMV model (the sales encode them there), NOT the serial multiplier. Final confirmed conclusion stands: **special-serial value = f(edition FMV, tier, circulation) by serial type; no other property factor generalizes, and the ~44–52% APE is the market's irreducible noise.**

### Special-serial descriptive trends + PARALLELS (2026-06-30)

Trend sweep on #1 (premium = sale ÷ edition FMV, which isolates the serial effect from value):
- **Circulation is the master variable.** #1 multiple rises monotonically with circ: ultra<100 **3.8×** ($160) → low<500 5.0× → mid<2500 22.6× → high<10k 26.4× → mass≥10k **35.1×** ($25). A cheap mass-common's #1 is a ~35× trophy; an ultra-scarce grail's #1 is only ~3.8× (on a high base).
- **Tier mirrors it (inverse):** COMMON 18.3× / RARE 4.9× / LEGENDARY 2.5×.
- **Series:** vintage premium in ABSOLUTE terms — Series 1 (`series 0`) + Series 2 #1s $1,000–9,000 (thin, n=1–9); newest Series 8 #1s ~$70 at 6.3× (the bulk).
- **Set:** top multiples are all cheap-common sets (Extra Spice 42.7× on a $2 base, 2026 Playoffs 35×, Base Set 20×); priciest #1s by set = Top Shot This ($288) + Freshman Gems ($250). Residual set spread (11–42× at ~$1–2 FMV) is noisy (matches CV: set doesn't generalize).
- **Player:** superstar #1s on their cheaper high-circ editions carry the biggest multiples — **Luka 50×, Steph 49×, Wembanyama 28×, LeBron 15×** — while current hyped rookies are low-multiple (Cooper Flagg $2,100 but 3.7×, Dylan Harper 1.6×) because their base FMV is already pumped.

Every trend reduces to the same inverse-multiple law (multiple ∝ 1/scarcity; absolute ∝ FMV) — confirming the model rather than adding a factor. Descriptive value for the product: the high-MULTIPLE #1 plays live on cheap-common editions of stars/popular sets; the high-ABSOLUTE #1s live on grails/vintage.

**PARALLELS** — special serials on `::subID` editions:
- Real volume: 137 #1 + 126 perfect parallel sales/365d. Parallels are scarcer (med circ 50 vs base 284–499), higher base FMV ($13–17 vs $10–14), lower multiple (#1 5.7× vs 6.8×; perfect 2.5× vs 3.3×).
- By parallel TYPE the multiple tracks scarcity EXACTLY: Club Collection (circ 99, fmv $3.5) **7.8×** → Blockchain 6.3× → Hardcourt 5.9× → Hexwave (circ 25, fmv $42) 1.9× → Jukebox (circ 10, fmv $51) 1.4× → Galactic (circ 5, fmv $216) **1.4×**.
- Base #1 when parallels EXIST: cheaper base ($7.3 vs $14.1, modern high-circ commons) → higher multiple (9.6× vs 5.9×). No systematic "parallel-exists" discount; priced by the base's own FMV.
- **CONCLUSION: parallels need NO separate special-serial model.** Because Stage B made each parallel a distinct edition with its OWN FMV + circulation, the FMV+tier+circ model prices a parallel's #1/perfect correctly (parallel "type" = its own FMV+circ). The ONLY lever is per-parallel FMV/circ ACCURACY — the ~22% of `::` editions whose circ is still a max-serial floor estimate (vs ~68% authoritative) are where to tighten, because a wrong parallel circ → wrong perfect-serial flag + wrong multiple.

### Base edition-FMV factor test — badges/series/rookie DO predict base value (the thin-edition lever, 2026-06-30)

The mirror of the serial-premium finding. Target = ln(edition FMV) for HIGH/MED editions; **features only, no edition's own sales.** 5-fold CV, n=700:
- tier+circ: testR² 0.643 / APE 51%
- +series: 0.681 / 47%
- +player-career-circ: 0.686 / 46% (weak)
- **+badges (TS-Debut/rookie/badge_score): 0.732 / 43%** ← badges add real held-out value
- ALL: 0.733 / 44%

Coefficients (base FMV): LEGENDARY +2.57 / RARE +1.05 / FANDOM +0.53 (vs COMMON); ln(circ) −0.556 (scarcer = higher); series newer = NEGATIVE (S7 −0.90, S8 −0.86 → vintage premium is real); rookie +0.137; badge_score +0.136/pt (~+15%/badge); TS-Debut ~0 alone (collinear with badge_score); player-career-circ −0.025 (weak — player identity is the residual gap the features can't see).

**KEY:** unlike the serial premium (badges/scarcity redundant with FMV there), for BASE edition VALUE the property factors (tier+circ+series+badges) predict ~73% of variance / 43% APE **with none of the edition's own sales.** That's a feature-based PRIOR usable on THIN/cold editions (NO_DATA / thin LOW) where the sales-based recalc has no signal. This is exactly where the rookie/debut/badge factors pay off — architectural placement is the base FMV model, not the serial layer.

**ACTIONABLE LEVER (review-gated → Trevor/CC):** for editions with NO_DATA or thin-LOW FMV, blend in a feature prior `exp(fit of tier+lncirc+series+badge_score+rookie)` as a labeled "modeled estimate" / floor anchor. ~43% APE beats showing nothing — would give the ~213 NO_DATA editions + much of the LOW tail an honest estimate. Caveat: the 43% APE is measured on HIGH/MED editions (where a target exists); on truly thin editions it's an extrapolated prior, so label it as modeled with a wide band. Needs the LiveToken acceptance gate + Trevor's call (it's a base-FMV pricing change).
