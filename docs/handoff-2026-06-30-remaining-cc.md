# Claude Code handoff — remaining FMV / serial / pack-EV work (2026-06-30)

The jersey-match pricing engine is built, refit on the canonical column, and verified live. This doc is the authoritative list of **what's left**: one small high-value item, one env-gated item, and two optional. Exact code + verify + revert for each.

Infra: Supabase `bxcqstmqfzmuolpuynti`; TS collection_id `95f28a17-224a-4025-96ad-adf8a4c63bfd`. Full analysis record: `docs/handoff-2026-06-30-moment-fmv-ev-dialin.md` + `docs/overnight/ledger.md` (2026-06-30).

---

## Current LIVE state (verified — do NOT redo)
- **7-arg `serial_fmv_estimate(p_collection_id, p_serial, p_circulation, p_tier, p_edition_fmv, p_confidence, p_jersey_number)`** — adds jersey pricing + a `low_confidence` flag (true on the data-starved grail tail); first/perfect/grid logic byte-identical to the live 6-arg, which is untouched. Verified.
- **`serial_fmv_jersey_model` + `compute_serial_fmv_jersey_model()`** — REFIT on `editions.jersey_number` (migration `audit_20260630_jersey_model_use_editions_jersey_number`). Cells: COMMON k27.96/β0.50 (n158), RARE k6.69/β0.86 (n135), ALL-pooled k24.66/β0.46 (n358) reliable; FANDOM/LEGENDARY → ALL. Validated: median actual $50 vs predicted $48, **47.7% median APE** (in band). Weekly cron `rpc-serial-fmv-jersey-weekly` (jobid 30).
- **`get_moment_detail` + `get_trophy_slab_data`** call the 7-arg, but currently pass **`players.jersey_number`** (Item 1 fixes this).
- **`get_pack_ev_contributors`** + the dist-page "What drives the remaining EV" panel — LIVE (commit `9b619fb`).
- **`v_topshot_fmv_feature_prior`** — read-only cohort FMV prior + divergence flag (analysis only; player-blind, NOT a mispricing detector — see its COMMENT).

---

## Item 1 — HIGH VALUE, SMALL: swap jersey caller column `players.jersey_number` → `editions.jersey_number`
**Why:** `editions.jersey_number` (smallint, per-moment) is the CANONICAL jersey signal — the jersey BADGE (`get_edition_special_serials`) uses it; it covers ~8,970 editions vs ~2,463 for `players.jersey_number`, and is correct for number-changers (the two disagree on 348 editions). The model + badge are already on `editions.jersey_number`; the price callers must match. **Lifts jersey-priceable editions 1,199 → 3,899 (3.25×)** and makes the jersey PRICE consistent with the jersey BADGE (today they can land on different serials for number-changers).

Change ONLY the 7th arg in each call (it's a direct column on the edition — simpler than the current players sub-join):
- **`get_moment_detail(text)`** — 7th arg →
  `(SELECT e.jersey_number FROM public.editions e WHERE e.id = v_resolved.edition_id AND e.jersey_number > 1)`
- **`get_trophy_slab_data(uuid)`** — 7th arg →
  `(CASE WHEN e.jersey_number > 1 THEN e.jersey_number END)`   (editions `e` is already joined)

Procedure: `pg_get_functiondef` the current def, change ONLY the 7th arg, re-apply via migration, re-fetch + diff vs old to confirm only the call changed. CREATE OR REPLACE preserves SECDEF/search_path/grants.
Verify: a number-changer moment now shows the jersey price on the SAME serial as the badge; an editions-jersey-but-not-players edition now shows a jersey premium; spot-check a #1 + a normal + a Pinnacle moment for no regression; `check_public_security_invariants()` = []. Revert: restore the `players.jersey_number` arg.

---

## Item 2 — ENV-GATED: per-parallel circulation accuracy
~22% of `::` parallel editions carry a max-serial FLOOR circulation (vs ~68% authoritative). A wrong parallel circ corrupts its perfect-serial flag AND its serial-premium multiple (the multiple is inverse to circ). Fix: pull GQL `searchEditions` (`parallelID` + `circulationCount`) via topshot-proxy and `GREATEST`-raise `editions.circulation_count` on `::` rows (never lower the observed-serial floor). Needs proxy egress (a Vercel admin route or worker) — not doable from Cowork. Bounds the special-serial pricing accuracy on parallels.

---

## Item 3 — OPTIONAL: LiveToken re-gate before leaning on jersey publicly
The jersey model is sales-validated (47.7% APE, central within ~4%) and `SERIAL_FMV_PUBLIC` is already true. Before relying on it for the public jersey line at scale, re-run the LiveToken acceptance cross-check on a sample of `editions.jersey_number` jerseys (method: `docs/cowork-skills/rpc-fmv-audit/SKILL.md`). Established expectation: RPC straddles LiveToken on the bulk; LiveToken OVER-prices illiquid grails — the model returns `low_confidence:true` and holds at base there, which is the safe direction.

---

## Item 4 — OPTIONAL / DEFERRED: explicit circulation in the #1 power model
CV-validated but MARGINAL (test R² 0.61→0.66, APE 46%→44%) and it refits the live #1 estimator that also feeds the underpriced-#1s deal board. Hold unless desired; if pursued, add a circ term to `compute_serial_fmv_power_model` and re-run the LiveToken gate before shipping.

---

## Context / findings (for reviewers — all CV / sales validated)
- **Special-serial premium = f(edition FMV, tier, circulation) by serial type.** series / play_category / player-stardom / badges / parallel-type were ALL tested with 5-fold CV and REJECTED on held-out accuracy (redundant with FMV). ~44–52% irreducible APE. Jersey-match ~16.7× the typical serial; modeled like #1.
- **Parallels need no separate model** — each `::` is its own edition with its own FMV+circ; the special-serial multiple tracks parallel scarcity exactly. Only lever = per-parallel circ accuracy (Item 2).
- **Base edition FMV:** tier+circ+series+badges predict ~73% of variance (~39% APE feature prior) but are PLAYER-BLIND — can't price thin star editions and the divergence flag is dominated by legit stars (NOT a mispricing detector). Edition FMV (sales-derived, stardom-aware) is the near-sufficient statistic; the thin-tail lever is more sales density, not a feature prior.
- **Pack EV (Trevor's direction):** headline EV = value of what REMAINS (drop_weight basis is correct). The lever is FMV honesty on the surviving chase editions (the panel surfaces it), bounded by the secondary-ask gate — NOT re-anchoring to realized pull mean.
