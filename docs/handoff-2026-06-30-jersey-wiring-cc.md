# Claude Code handoff — Jersey FMV wiring + pack-EV viz (2026-06-30)

## TL;DR
The jersey-match special-serial pricing **engine is already live** (shipped from Cowork via Supabase MCP, verified). Two last-mile pieces need CC because they're unsafe from Cowork right now: **(A)** one-line caller wiring of two 250-line DB functions to surface jersey on the moment page + trophy slabs, and **(B)** the pack-dist "What drives the remaining EV" panel (.tsx — needs tsc + deploy verify; the Vercel MCP was down in the Cowork session). Both are fully specified below with exact code + revert paths.

Infra: Supabase project `bxcqstmqfzmuolpuynti`; TS collection_id `95f28a17-224a-4025-96ad-adf8a4c63bfd`. Full analysis record: `docs/handoff-2026-06-30-moment-fmv-ev-dialin.md` + `docs/overnight/ledger.md` (2026-06-30 entries).

---

## CORRECTION (post-ship 2026-06-30) — use editions.jersey_number, NOT players.jersey_number

Verified live: **`editions.jersey_number`** (smallint, per-moment) is the CANONICAL jersey signal — it's what `get_edition_special_serials`/the jersey BADGE uses, has **3.6x the coverage** (~8,970 editions vs ~2,463 for `players.jersey_number`), and is correct for number-changers (the two columns disagree on 348 editions). The earlier handoff said `players.jersey_number` (matching the model's training); that was the narrower/wrong column.

DONE (Cowork, live): the jersey MODEL was **refit on `editions.jersey_number`** (`audit_20260630_jersey_model_use_editions_jersey_number`) — n 160->358, RARE now reliable (β0.86); COMMON+RARE+ALL reliable. Verified.

**CC ACTION — swap the 7th arg in both callers from the players lookup to `editions.jersey_number` (simpler — it's a column on the edition):**
- `get_moment_detail`: `(SELECT e.jersey_number FROM public.editions e WHERE e.id = v_resolved.edition_id AND e.jersey_number > 1)`
- `get_trophy_slab_data`: `(CASE WHEN e.jersey_number > 1 THEN e.jersey_number END)`  (editions `e` already joined)

This makes the jersey PRICE consistent with the jersey BADGE and lifts coverage ~2,463 -> ~8,970 editions. The players.jersey_number wiring already shipped is functional but narrow and can put the price on a different serial than the badge for number-changers.

---

## Already LIVE (DB, additive, reversible — do NOT re-do)
1. **`serial_fmv_jersey_model`** (table) + **`compute_serial_fmv_jersey_model()`** — jersey premium model, v2 (sub-linear, reliability gate `n>=40 AND r>=0.35 AND 0.15<beta<1.0`; COMMON + ALL-pooled reliable, RARE/LEG/FANDOM fall back to ALL). Sales-validated on the bulk (base FMV < ~$150). Revert: `DROP FUNCTION public.compute_serial_fmv_jersey_model(uuid,integer,integer,numeric); DROP TABLE public.serial_fmv_jersey_model;`
2. **7-arg `serial_fmv_estimate(p_collection_id uuid, p_serial int, p_circulation int, p_tier text, p_edition_fmv numeric, p_confidence text, p_jersey_number int)`** — additive overload (migration `audit_20260630_serial_fmv_estimate_7arg_jersey`). Detects jersey (serial = jersey_number, checked AFTER #1/perfect), prices via the jersey model, returns a `low_confidence` flag (true when base FMV exceeds the model `fmv_max` or the estimate is ~= base, i.e. the data-starved grail tail). The `first`/`perfect`/grid logic is byte-identical to the live 6-arg. **The 6-arg is UNTOUCHED; the jersey param is required so the two overloads are unambiguous.** Verified live: LeBron #23 -> $202.71 jersey; a grail -> `low_confidence:true` held at base; normal serial -> NULL; 6-arg byte-identical. Revert: `DROP FUNCTION public.serial_fmv_estimate(uuid,integer,integer,text,numeric,text,integer);`
3. **Weekly cron `rpc-serial-fmv-jersey-weekly`** (pg_cron jobid 30, `5 11 * * 0`). Revert: `SELECT cron.unschedule('rpc-serial-fmv-jersey-weekly');`
4. **`get_pack_ev_contributors(p_dist_id text, p_limit int)`** — top remaining pool editions by per-slot EV contribution + FMV confidence (backs Item B). Revert: `DROP FUNCTION public.get_pack_ev_contributors(text,integer);`
5. **`v_topshot_fmv_feature_prior`** — read-only cohort FMV prior + divergence flag. ANALYSIS ONLY; NOT a mispricing detector (player-blind — its over_3x set is dominated by legit stars, not stale FMV; see the view COMMENT). Revert: `DROP VIEW public.v_topshot_fmv_feature_prior;`

---

## Item A — Jersey caller wiring (lights up jersey on the moment page + trophy slabs)
Two SECDEF functions call the 6-arg `serial_fmv_estimate`. Add `jersey_number` as the 7th arg so they hit the new overload. Both surfaces already render whatever `serial_fmv` comes back — the moment page (`app/moment/[id]/page.tsx` ~L1025) renders `sfmv.estimate_usd` + label gated on `SERIAL_FMV_PUBLIC` (already true in prod) — so **no .tsx change is needed for the moment jersey line; it lights up automatically** once the function passes the number.

Procedure (per function): `SELECT pg_get_functiondef('public.get_moment_detail(text)'::regprocedure);`, change ONLY the `serial_fmv_estimate(...)` call, re-apply via `apply_migration`, then re-fetch the def and diff vs the original to confirm only the call changed. CREATE OR REPLACE preserves SECDEF/search_path/grants.

### get_moment_detail(text) — current call
```
v_serial_fmv := public.serial_fmv_estimate(
  v_resolved.collection_id,
  (v_serial->>'serial_number')::int,
  (v_edition->>'circulation_count')::int,
  (v_edition->>'tier'),
  (v_fmv->>'fmv_usd')::numeric,
  (v_fmv->>'confidence')
);
```
### -> change to (add 7th arg)
```
v_serial_fmv := public.serial_fmv_estimate(
  v_resolved.collection_id,
  (v_serial->>'serial_number')::int,
  (v_edition->>'circulation_count')::int,
  (v_edition->>'tier'),
  (v_fmv->>'fmv_usd')::numeric,
  (v_fmv->>'confidence'),
  (SELECT max(p.jersey_number) FROM public.players p JOIN public.editions e ON e.player_id = p.id
     WHERE e.id = v_resolved.edition_id AND p.jersey_number > 1)
);
```

### get_trophy_slab_data(uuid) — current call (inside a SELECT with editions `e` joined)
```
public.serial_fmv_estimate(
  tm.collection_id,
  tm.serial_number,
  COALESCE(e.circulation_count, tm.circulation_count),
  COALESCE(e.tier::text, tm.tier),
  COALESCE(f.fmv_usd, tm.fmv),
  f.confidence::text
) AS serial_fmv,
```
### -> change to (add 7th arg)
```
public.serial_fmv_estimate(
  tm.collection_id,
  tm.serial_number,
  COALESCE(e.circulation_count, tm.circulation_count),
  COALESCE(e.tier::text, tm.tier),
  COALESCE(f.fmv_usd, tm.fmv),
  f.confidence::text,
  (SELECT max(p.jersey_number) FROM public.players p WHERE p.id = e.player_id AND p.jersey_number > 1)
) AS serial_fmv,
```

Notes: jersey serials that are ALSO #1 or perfect stay priced as #1/perfect (checked first) — intended. The `max(...)` guards the ~3x dup-player-rows issue. Verify: `SELECT (public.get_moment_detail('<known jersey moment_id>'))->'serial_fmv';` shows label "estimated jersey-match premium"; spot-check a #1, a normal, and a Pinnacle moment for no regression; `check_public_security_invariants()` = []. Revert: re-apply the prior def (drop the 7th arg).

---

## Item B — Pack dist "What drives the remaining EV" panel
File: `app/(collections)/[collection]/pack/dist/[distId]/page.tsx`. TS dists only. Backed by the live `get_pack_ev_contributors`. The page's data client is `supabaseAdmin` (from `@/lib/supabase`); render with the page's OWN idioms (`Td` helper ~L1951, inline styles, `tierChip`) — it has NO shared `Section`/`ConfidencePill`.

Fetch (add `fetchEvContributors` to the existing `Promise.all` ~L744 + destructure):
```ts
async function fetchEvContributors(distId: string) {
  const { data, error } = await supabaseAdmin.rpc("get_pack_ev_contributors", { p_dist_id: distId, p_limit: 12 })
  if (error) { console.error("[pack-detail] ev_contributors", error.message); return [] }
  return Array.isArray(data) ? data : []
}
```
Render (gate `collection === "nba-top-shot" && evContributors.length > 0`; place under the EV / reality-check block). Reference markup — adapt to the page's `Td`/inline-style idiom; use brand tokens, never hardcode `#E03A2F`:
```tsx
<section style={{ marginTop: 40 }}>
  <h2 /* match the page's h2 style */>What drives the remaining EV</h2>
  <p style={{ color: "var(--rpc-text-muted)", fontSize: 13, marginBottom: 10 }}>
    Each row is an edition still in the pool. EV share = its pull probability x its FMV, as a fraction of the
    pack's per-slot expected value -- i.e. what you're actually paying for in what remains.
  </p>
  {(() => {
    const low = evContributors
      .filter((c:any)=>["LOW","ASK_ONLY","STALE","NO_DATA"].includes(c.confidence))
      .reduce((s:number,c:any)=>s+Number(c.pct_of_ev||0),0)
    return low >= 25 ? (
      <p style={{ color: "var(--rpc-amber,#e0a52f)", fontSize: 12.5, marginBottom: 10 }}>
        &#9888; {Math.round(low)}% of the remaining EV leans on low-confidence chase prices -- treat it as soft.
      </p>) : null
  })()}
  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
    <thead><tr>
      <th style={{textAlign:"left"}}>Edition</th><th>Tier</th><th>Pull %</th><th>FMV</th><th>EV share</th>
    </tr></thead>
    <tbody>
      {evContributors.map((c:any)=>(
        <tr key={c.edition_id}>
          <td style={{textAlign:"left"}}>{c.player_name} &middot; {c.set_name}</td>
          <td>{c.tier}</td>
          <td>{(Number(c.pull_prob)*100).toFixed(2)}%</td>
          <td>{c.fmv_usd!=null?`$${Number(c.fmv_usd).toFixed(2)}`:"—"} &middot; {c.confidence}</td>
          <td>{Number(c.pct_of_ev).toFixed(1)}%</td>
        </tr>
      ))}
    </tbody>
  </table>
</section>
```
Verify: tsc clean; deploy READY + smoke; a chase pack's contributors sum to ~100% EV share; low-confidence caveat fires when warranted. Revert: `git revert`.

---

## Item C — Deferred / optional (Trevor's call, not required)
- **Explicit circulation in the #1 power model.** CV-validated but MARGINAL (test R^2 0.61->0.66, APE 46%->44%) and it refits the live #1 estimator that also feeds the underpriced-#1s deal board. Hold unless desired; if pursued, add a circ term to `compute_serial_fmv_power_model` + re-run the LiveToken acceptance gate before shipping.
- **Per-parallel circ accuracy.** ~22% of `::` parallel editions still carry a max-serial FLOOR circulation (vs ~68% authoritative). A wrong parallel circ corrupts its perfect-serial flag + multiple. Fix needs GQL `searchEditions` (parallelID + circulationCount) via topshot-proxy (env-gated) to GREATEST-raise `editions.circulation_count` on `::` rows.

---

## Key findings (context for reviewers — all CV / sales validated)
- **Special-serial premium = f(edition FMV, tier, circulation) by serial type.** series / play_category / player-stardom / badges / parallel-type were ALL tested with 5-fold CV and REJECTED on held-out accuracy (redundant with FMV). ~44-52% irreducible median APE (special-serial prices are genuinely high-variance). Jersey-match serials trade ~16.7x the typical serial; the jersey model is the same power-law form as #1, sales-validated for the bulk, conservative + low-confidence-flagged on grails.
- **Parallels need no separate model** — each `::` is its own edition with its own FMV + circ; the special-serial multiple tracks parallel scarcity exactly (Club Collection ~7.8x -> Galactic ~1.4x). The only lever is per-parallel circ/FMV accuracy (Item C).
- **Base edition FMV:** tier+circ+series+badges predict ~73% of variance (~39% APE feature prior) but are PLAYER-BLIND — can't price thin STAR editions and the divergence flag is dominated by legit stars, so it is NOT a mispricing detector. Edition FMV (sales-derived, stardom-aware) remains the near-sufficient statistic; the thin-tail lever is more sales density, not a feature prior.
- **Pack EV (per Trevor's direction):** headline EV = value of what REMAINS in the pack (the drop_weight basis is correct). The model runs ~4x / calibrated ~2.5x the realized pull mean on opened packs; the lever is FMV honesty on the surviving chase editions (Item B surfaces this) bounded by the secondary-ask gate — NOT re-anchoring to realized.
