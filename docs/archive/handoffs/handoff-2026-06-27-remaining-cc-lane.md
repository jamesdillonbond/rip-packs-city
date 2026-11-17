# Claude Code handoff — 2026-06-27 ops-safety + cost: remaining lane

Consolidated from the 2026-06-27 Cowork ops-safety/cost session. The large items already shipped (AllDay unmapped resolver, the delete circuit-breaker, per-collection FMV freshness, the sentinel false-alarm fix, context hygiene). **These four remain.** Read each premise and re-measure live before acting — figures here were verified this session but the repo/DB move. Normal markdown, read on desktop. Full rationale: `docs/long-term-ops-safety-plan-2026-06-27.md`.

## READ FIRST — new constraints + what's already closed
- **Delete circuit-breaker is LIVE** (`rpc_guard_block_destructive` + config table `rpc_delete_guard_config`; migration `audit_20260627_delete_guard_circuit_breaker`). It blocks: `DELETE` on `wallet_moments_cache` spanning **>3 distinct wallets**; `DELETE` on `editions`/`pinnacle_editions` **>25 rows**; `TRUNCATE` on those three. For a genuinely intentional bulk delete, `SET LOCAL rpc.allow_bulk_delete='on'` inside the txn. **This directly affects Item 2** — re-key via `UPDATE`, not delete, and the guard never trips.
- **Per-collection FMV freshness** is now in `v_rpc_trust_health` (`topshot/allday/golazos/ufc_fmv_stale_hours`, breach 6/12/30/30h). Don't re-add.
- **Already CLOSED — do NOT re-do:** AllDay V1 unmapped resolver (shipped `5caeabe`/`4b2c6a6`/`04f96f2` — forward `AllDay.Deposit` scan to current holder); BUYERBF-PERINVOCATION-WORK (reconciled healthy, no overlap); UFC-EDITIONS-SEED-GAP (already 0); the ~547 old AllDay April rows (accepted hard residual — proven unresolvable: escrow/burned, no later Deposit).

---

## Item 1 — Vercel dependabot-preview build-cost fix  [deploy config · highest $ leverage]

**Why.** On-demand Vercel cost is ~69% **Build CPU** ($44.63 of ~$65/cycle, verified 06-27). The driver is a backlog of **dependabot preview builds** (each dependabot PR builds a preview). The current `vercel.json` `ignoreCommand` only skips docs-only diffs, so dependabot PRs (which touch `package.json`/lock) build every time.

**Change — extend `ignoreCommand` to also skip PREVIEW builds on `dependabot/*` branches. Production path unchanged.**
Current:
```
"ignoreCommand": "git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx'"
```
Proposed:
```
"ignoreCommand": "if [ \"$VERCEL_ENV\" = \"preview\" ] && case \"$VERCEL_GIT_COMMIT_REF\" in dependabot/*) true;; *) false;; esac; then exit 0; else git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx'; fi"
```
`exit 0` = skip, non-zero = build. The `else` branch is the existing command verbatim → production + non-dependabot previews behave exactly as today.

**Verify (this is why it's a CC item — needs build observation):** after deploy READY, the next dependabot PR shows **"Skipped"** (not a build); a real code commit to `main` still builds + deploys READY + smoke passes. **Revert:** restore the one-line `ignoreCommand`. *(No-code partial alternative: merge/close the ~7 open dependabot PRs so their previews stop — but they recur; the `ignoreCommand` is durable.)*

---

## Item 2 — TS `wmc` UUID-fossil on-chain re-resolution  [DB + admin route]

**Why.** ~1,753 `wallet_moments_cache` rows for TopShot have a UUID-form `edition_key` (fails the canonical `^[0-9]+:[0-9]+(::[0-9]+)?$`) — fossils from merged/deleted UUID-dup editions. They are **NOT inert**: they carry denormalized player/set/serial and **render real moments on `/share` + `get_wallet_collection_snapshot`** (this is why the 06-27 blind-delete had to be reverted). So **re-key, never delete.** The gap is they don't link to the canonical edition page / live FMV.

**Infra that already exists:** `app/api/admin/drain-topshot-misattribution/route.ts` resolves an `nft_id`'s true on-chain identity via `getMintedMoment` through the **topshot-proxy** (X-Proxy-Secret; aliased GraphQL chunks of 40), writes `topshot_misattrib_onchain_map`, and `remap_topshot_from_onchain_map()` re-keys **sales + moments**. The wmc rows carry `moment_id`, which is what `getMintedMoment` needs.

**What to add (two DB-side legs + reuse the route's resolver):**
1. A **target selector** for the wmc fossils: TS `wmc` rows where `edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`, keyed by `moment_id` (resolve each to its canonical `setID:playID`).
2. A **wmc remap leg** (extend `remap_topshot_from_onchain_map()` or a sibling): `UPDATE wallet_moments_cache SET edition_key = '<setID:playID>'` from the resolved map, **honoring the `wmc.edition_key == editions.external_id` contract** — the canonical edition must exist (seed via `ensure_topshot_edition_stub` on a miss). Use **UPDATE in place** (re-key) — not delete — so the delete-guard is a non-issue and the rows keep rendering throughout.
3. Per-row audit table before the UPDATE for revert.

**Verify:** `SELECT count(*) FROM wallet_moments_cache w JOIN collections c ON c.id=w.collection_id WHERE c.slug='nba_top_shot' AND w.edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$';` drops from ~1,753; pick an affected wallet and confirm its `/share` tiles still render AND now resolve to canonical edition pages / FMV; trust-health unchanged; no wmc rows orphaned from `editions`. **Revert:** restore `edition_key` from the audit table. **Note:** batch the on-chain `getMintedMoment` calls (the drain route already chunks 40); ~1,753 is small vs the 1.58M-row table.

---

## Item 3 — table-driven sentinel thresholds  [route + DB]

**Why.** All ~8 sentinel checks in `app/api/sentinel/route.ts` have **hardcoded thresholds** (in the ~L91–289 region: Sales-Ingest-2h crit==0, FMV-Freshness warn 2h/crit 6h, FMV-Confidence-canonical-TS warn <25%, Edition-Coverage warn <90%, TS-Writer-Leak-48h warn 250/crit 2000, Pipeline-Silence via `detect_stalled_pipelines`, Total-Sales info, Sniper-Feed warn deals==0). Tuning any of them needs a deploy.

**Change.** Create a config table (e.g. `sentinel_threshold_config(check_name text pk, warn_at numeric, crit_at numeric, enabled bool default true, note text)`, RLS on, service_role only — mirror `pipeline_cadence_watchlist`/`rpc_delete_guard_config`). Seed it with the **current hardcoded values verbatim**. Have the route read thresholds from it, **falling back to the hardcoded default if a row is missing** (so a config gap can never silently disable a check). Pipeline-Silence stays delegated to `detect_stalled_pipelines()` (already table-driven via the watchlist).

**Verify:** a sentinel run produces identical status to before (same thresholds, now table-sourced); editing a row changes behavior with no deploy; a deleted/missing row falls back to the hardcoded default (not "disabled"). **Revert:** route reads hardcoded again; drop the table.

---

## Item 4 — decouple critical writers off cron-job.org  [GHA / infra]

**Why.** The cron-job.org trigger surface has a recurring degradation class: `allday-fmv-populate` silently stopped firing 06-26 22:42Z (caught by the watchlist); `topshot-listing-cache` dropped earlier and was fixed by moving it to GHA (`35fb466f`, "GHA-decouple"). cron-job.org should not be the trigger for anything whose silence is a real incident.

**Change.** Audit the cron-job.org entries (`docs/operations/cron-schedule.md` is the regenerated reference). For each **critical** pipeline — start from `SELECT pipeline FROM pipeline_cadence_watchlist WHERE is_active;` and cross-ref which are cron-job.org-triggered vs already GHA/pg_cron/Vercel — move the trigger to a **GHA `on: schedule:`** workflow (or **pg_cron** for pure-DB work), mirroring `35fb466f`. Each GHA cron = a workflow that curls the route with the secret from repo secrets (pattern: `.github/workflows/rpc-pipeline.yml`). Keep cron-job.org only for genuinely low-stakes jobs. Preserve the 2026-06-07 stagger (don't re-bunch on `:00`).

**Gotcha:** a CC session (Trevor's gh auth) **can** push `.github/workflows/**`; the nightly-pass PAT cannot (lacks `workflow` scope), so this is CC-only. **Verify:** each migrated writer logs `ok` ticks on the new GHA/pg_cron schedule; the old cron-job.org entry is disabled; `detect_stalled_pipelines()` stays `[]` across the cutover. **Revert:** re-enable the cron-job.org entries; delete the GHA schedules.

---

### Suggested order
1 (5-min config win + biggest $) → 3 (DB+route, self-contained) → 4 (infra, methodical) → 2 (most careful: on-chain + canonical-merge path). Items 1/3/4 are independent; do 2 last with full verification.
