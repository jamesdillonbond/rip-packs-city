# Handoff — Pack lifecycle measurement + dist attribution + EV reality-check (2026-06-27, Cowork)

## Context

Cowork built the data foundation for "how many TS packs opened / still sealed / what's been pulled" and an EV reality-check, then shipped everything DB-side live. This handoff covers the **route/.tsx + edge-fn + secret-gated** pieces Cowork can't push.

**Already shipped LIVE by Cowork (migrations + 1 artifact, all verified, security invariants `[]`):**
- `audit_20260627_topshot_pack_rip_attribution_table` — new additive table `topshot_pack_rip_attribution` (rip_id→dist_id, method, confidence). Does **not** mutate `pack_rips.dist_id`, so it never collides with `backfill_pack_rip_metadata()` or the `pack_rips_propagate_dist_trg` trigger.
- `audit_20260627_attribute_topshot_rips_empirical_fn` + `_random_order` — resolver `attribute_topshot_rips_empirical(int)` (SECDEF, service_role only).
- `audit_20260627_v_topshot_pack_lifecycle` — per-dist lifecycle view.
- `audit_20260627_v_topshot_pack_lifecycle_global` — one-row TRUE global lifecycle.
- `audit_20260627_v_topshot_pack_realized_ev` — modeled-EV-vs-realized-pull view.
- Cowork artifact `rpc-pack-lifecycle` (live dashboard).

**Seeded data:** 39,489 confirmed attributions (the existing 21%) + ~150 empirical. Re-runnable via `SELECT attribute_topshot_rips_empirical(20000);`.

**What the foundation proves (verified, Apr 10 → Jun 27 window):** 187,547 packs opened · 28,748 observed-sealed · 514,172 moments pulled · ~$1.65M realized pull value · only **21%** of opens attributed to a specific dist · per-dist **sealed is ~0** because an unopened pack never gets a dist tag.

**Coordinate:** the 2026-06-26 ledger entries already shipped a pack "value still sealed" strip + EV-honesty mutes (`65800e3`) + the pack-events wedge fix (`80a9238`). Nothing here reverts those — items 1/2 build on top. Re-read `docs/overnight/ledger.md` before starting.

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## Item 1 — Wire the pack pages to real lifecycle numbers (route + RPC) — HIGH, low risk

**Why:** `pack_distributions.total_minted/total_opened/total_sealed/depletion_pct` are **dead — all zeros for every TS dist**, and `get_pack_detail` / `get_pack_for_simulator` pass them straight through to the UI (verified: they're literal `'total_opened', v_pack.total_opened` passthroughs). So the pack pages show 0 opened / 0 sealed today. The new `v_topshot_pack_lifecycle` has the real, honest numbers.

**Files (verified to exist):**
- `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (consumes `get_pack_detail`)
- `app/(collections)/[collection]/packs/simulator/[distId]/page.tsx` (consumes `get_pack_for_simulator`)
- The two RPCs `get_pack_detail` / `get_pack_for_simulator` (migration).

**Change:** in `get_pack_detail` (and `get_pack_for_simulator`), `LEFT JOIN public.v_topshot_pack_lifecycle l ON l.dist_id = <dist>` for TS and return its honest fields instead of the dead counters:
- `packs_opened`, `packs_opened_confirmed`, `packs_opened_inferred`
- `moments_pulled`, `realized_pull_value_usd`, `avg_realized_value_per_pack`
- `packs_sealed_observed` (will be ~0 until Item 3 — render it as "—"/hidden when 0, **do not show a false 0**)
- `observed_depletion_pct` (NULL until Item 3 gives a true denominator — render only when non-null)

**Honesty rules for the UI** (so we don't claim false precision):
- Label opened as **"packs opened (observed since Apr 2026)"**, not "total minted."
- Only show depletion % / sealed when we actually have them (post-Item 3); until then lead with opened + realized value, which ARE solid.
- For dists with `packs_opened_confirmed = 0` but `packs_opened_inferred > 0`, tag the number "inferred."

**Verify:** `npx tsc --noEmit` clean; dist page for dist `7800` (Fast Break Classic Run 12) shows ~21,590 opened / ~$268k realized / $12.44 avg; deploy READY; pack smoke passes.
**Revert:** `git revert <commit>` + restore prior RPC bodies (CREATE OR REPLACE back; keep the REVOKE/GRANT discipline).

---

## Item 2 — EV reality-check: surface it, then calibrate (REVIEW-GATED pricing change) — HIGH value

**Why:** `v_topshot_pack_realized_ev` compares the modeled `pack_ev_latest.gross_ev` (drop-weight-weighted FMV avg, computed by the RPC inside `supabase/functions/compute-topshot-pack-ev/index.ts`) against what packs **actually pulled** (`pack_rips.pull_value_usd`), for 199 dists with ≥10 attributed opens. The model is wildly off for many dists, both directions:
- `5640` Phantom Threads "Guaranteed Hit": modeled **$46.88** vs realized **$4.00** (0.085×) — model massively over-values.
- `1548` Run It Back: Origins ($160 pack): modeled $47.83 vs realized **$10.69** (0.22×).
- `7584` Courtside Chance Hit: modeled $70.48 vs realized $21.77 (0.31×).
- `6452`: modeled $18.58 vs realized $19.42 (**1.05× — model is right here**).

**Two-stage, the second is the pricing change → your call after review:**
1. **Surface (safe, additive):** show the realized distribution (mean/median/p90 + `realized_to_modeled_ratio`) next to modeled EV on the dist page, and add a QA flag to the EV pipeline when `|ratio|` is far from 1 on a high-`n_opens` dist. Pure transparency; no pricing change.
2. **Calibrate (review-gated):** the divergence is concentrated in low-circulation "guaranteed/chance-hit" pools where the weighted-FMV model over-weights a rare grail's FMV (and depleted-edition FMV goes stale). Recommend a calibration term that pulls modeled EV toward realized mean for dists with `n_opens` above a threshold — **but this changes live pack pricing, so it should land as a reviewed CC change, not an autonomous one** (standing rule: central pricing logic is hand-off-for-review). Do NOT write a bespoke FMV/EV writer outside the canonical pipeline.

**Files:** `supabase/functions/compute-topshot-pack-ev/index.ts` (+ the `gross_ev` RPC it calls) and the dist page from Item 1.
**Verify:** EV pipeline run stays green; `fmv_sanity` 0; spot-check that `6452`-type on-model dists are unchanged and only off-model dists move. **Revert:** `git revert <commit>` (calibration is parameter-only).

---

## Item 3 — GQL historical pool reconstruction: the real attribution lift (edge fn + TS_PROXY_SECRET) — the "all of it" piece

**Why:** attribution is stuck at ~21% because ~79% of opened packs come from dists with **no drop pool to match** (depleted-edition drops + reward/airdrop packs whose pulled editions are disjoint from every pooled dist — measured: 94% of un-attributed rips have zero edition overlap with any attributed dist's empirical pool, and ~42% don't even resolve to an edition via `moments`). Empirical bootstrap + live-pool matching can't close this; the only authoritative source is **Top Shot's own per-distribution pack composition via GQL.**

**Build (Cowork-deployable as an edge fn, but scoped here because it needs GQL-shape verification + a secret):**
- New edge fn, e.g. `supabase/functions/backfill-topshot-pack-pools/index.ts`, that for each TS dist lacking a pool calls **topshot-proxy** (`workers/topshot-proxy`, `X-Proxy-Secret: TS_PROXY_SECRET`) with the pack-distribution / edition-pool GQL query, and writes rows into `pack_drop_pool` with `pool_source='gql_historical'` (+ `orig_drop_weight`).
- **Verify the GQL shape first** with the Cadence/GQL MCP on your machine (don't trust training data): confirm the query that returns a distribution's edition set + per-edition counts (the `searchPackDistributions` / drop-pool family). The existing `seed-topshot-pack-distributions` edge fn and `compute-topshot-pack-ev` already call the proxy — mirror their auth + request shape.
- After pools land, re-run attribution: `backfill_pack_rip_metadata()` (existing, matches live pool) **and** `attribute_topshot_rips_empirical()` (now richer empirical pools). The lifecycle views + per-dist sealed/depletion light up automatically — no view change needed.

**Then true `total_minted`/sealed become computable:** GQL drop size = minted; sealed = minted − opened. Feed that into Item 1's honesty rules (depletion stops being NULL).

**Verify:** attribution coverage (`v_topshot_pack_lifecycle_global.attribution_coverage_pct`) climbs well above 21%; `check_public_security_invariants()` `[]`; new pool rows `pool_source='gql_historical'`. **Revert:** `DELETE FROM pack_drop_pool WHERE pool_source='gql_historical';` + remove the edge fn.

---

## Item 4 — Keep it fresh (cron) — LOW, optional

Wire `attribute_topshot_rips_empirical(20000)` (and, post-Item-3, a lifecycle refresh) into a daily pg_cron tick so attribution + counters stay current as packs open. Mirror the existing `refresh-pack-grail-metrics-mv` cadence. DB-only; no deploy.

---

## Guardrails (every item)
- **Direct to `main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify push: `git rev-list --count origin/main..HEAD` → expect 0.
- Vercel REST via **PowerShell `Invoke-WebRequest`** (`curl` silently fails in Git Bash).
- Vercel Pro `maxDuration` hard cap **800s** — higher sends the deploy to ERROR invisibly.
- CRLF: full-file writes or `findIndex` on split lines — never string-replace-patch.
- Edge-fn secret-safety: never echo `TS_PROXY_SECRET`/Bearer values.

## DB revert reference (the live Cowork work)
```
DROP VIEW IF EXISTS public.v_topshot_pack_realized_ev;
DROP VIEW IF EXISTS public.v_topshot_pack_lifecycle;
DROP VIEW IF EXISTS public.v_topshot_pack_lifecycle_global;
DROP FUNCTION IF EXISTS public.attribute_topshot_rips_empirical(int);
DROP TABLE IF EXISTS public.topshot_pack_rip_attribution;   -- only after the views above are dropped
```
Artifact `rpc-pack-lifecycle`: retire via tombstone (Cowork) if unwound.

## Expected end state
Items 1–2 on `main`, deploy READY: the pack pages show real opened / realized value + the modeled-vs-realized EV check; Item 3 lifts attribution past 21% and unlocks true per-dist minted/sealed/depletion.
