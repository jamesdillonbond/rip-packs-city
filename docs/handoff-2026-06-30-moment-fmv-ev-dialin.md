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
