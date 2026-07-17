# Pinnacle grain migration — design doc (2026-07-17)

**Status:** proposal for Trevor's review. **No code or data changed by this doc.**
Author: Claude Code (interactive). All numbers read live from the production DB
(`bxcqstmqfzmuolpuynti`) on 2026-07-17.

---

## TL;DR / recommendation

The "migrate Pinnacle consumers off the legacy `pinnacle_editions` grain onto the
render grain `pinnacle_catalog`" work is **~80% already done** — most FMV/display
consumers (concierge, sniper, overview/collection stats, pack-EV, the render-grain
moment page) already read `pinnacle_catalog`. This is a **finish-the-migration**, not
a big-bang rewrite, and it decomposes into **three bounded, independently-shippable
pieces**:

1. **Unify ASK** (highest value): retire the legacy per-edition ASK writer
   (`pinnacle_editions.ask_price`, 327 live rows) in favor of the render-grain floor
   (`pinnacle_catalog.floor_ask`, 2,144 live rows) — but only *after* the last
   legacy-grain readers move over. This kills a duplicated live pipeline + one of two
   overlapping trust metrics.
2. **Retire the ~8 remaining legacy-grain reads** — mostly writers, one dead route, a
   couple of metadata reads, and one user-facing moment page.
3. **Decide the fate of the 152 unbridged legacy editions** (fossils: 0 have a live
   ask, none have a catalog render) and of `pinnacle_editions` itself (keep as
   ASK/metadata ingest staging, or drop).

**Recommendation (updated after Phase-1 execution):** the cheap parts of #2 are done (2
dead reads retired). The **two remaining #2 reads cannot be mechanically repointed** — see
the Phase-1 log's "character-lossy" blocker: the legacy `edition_key` maps one row to many
different-character renders, so any edition_key-keyed read (legacy *or* catalog) writes an
arbitrary character. Those two are ingest-time placeholder writers the render-id crons
already correct, so the real decision is data-architectural (drop the placeholder writes vs
resolve `render_id` at ingest) — Trevor's call, needs live verification. **#1 (ASK-unify)
is independent of that blocker and is now the highest-value, lowest-ambiguity next step.**
Do **not** attempt a single atomic cutover.

---

## Background: why two grains exist

Pinnacle has two parallel representations of "an edition," at different granularities:

| | `pinnacle_editions` (legacy) | `pinnacle_catalog` (render) |
|---|---|---|
| **Grain** | coarse — one row per `royalty_code:variant_type:printing` (`edition_key`) | fine — one row per **render** (`render_id`), the studio's actual per-artwork unit |
| **Rows** | 503 | 2,272 |
| **FMV** | none (ASK only) | `fmv_usd` on 2,214 / 2,272 (97%), render-keyed, engine `pinnacle-2.0.0-render` |
| **ASK** | `ask_price` on 327 (source `pinnacle_direct`), live (updated 2026-07-17 00:09Z) | `floor_ask` on 2,144, live (updated 2026-07-16 19:45Z) |
| **Thumbnails** | `thumbnail_url` | `thumbnail_url` + `front_anim_url` |
| **Role today** | ASK + metadata **ingest staging** | canonical **FMV + floor + display** grain |

The render grain is the correct long-term canonical unit: Pinnacle FMV is render-keyed
(per the CLAUDE.md "Pinnacle FMV lives in `pinnacle_catalog`/`pinnacle_fmv_history`, NOT
the uuid-keyed `fmv_snapshots`" invariant), and the studio catalog itself is
render-grained (2,272 = the full studio row count from `searchPinnacleEditions`).

### The bridge (the crux of the difficulty)

`pinnacle_catalog.legacy_edition_key = pinnacle_editions.edition_key`:

- **351 / 503** legacy editions bridge to ≥1 catalog render.
- Of those, **17 are 1:1** and **334 are 1:many** — i.e. the legacy grain is *coarser*;
  one legacy edition typically fans out to several render variants.
- **152 / 503** legacy editions are **unbridged** (no catalog render at all). Critically,
  **0 of those 152 carry a live ask** — they are dead fossils, not live inventory.

The 1:many relationship is why `mint_count` can't be summed across the bridge and why a
naive `JOIN` mis-prices: this is the exact footgun the concierge rule already guards
("NEVER join Pinnacle by `edition_key` alone — always the triple
`character_name, set_name, variant_type`").

---

## Current state — who reads which grain (live inventory)

Only **8 files** still issue a direct read against `pinnacle_editions`, and most are not
display consumers:

| File | Kind | Migration disposition |
|---|---|---|
| `app/(collections)/[collection]/moment/[momentId]/page.tsx` | **redirect-slug resolver** (not display — for Pinnacle it reads `pinnacle_editions` only to resolve a route slug, then `redirect()`s to `/edition/<slug>` or `/pinnacle/moment/<render>`) | low-stakes migrate: repoint the slug lookup at the catalog, or drop the fallback |
| `app/api/pinnacle/listings/route.ts` | **dead** (sole consumer `PinnacleSniper` unmounted; `/pinnacle` redirects) | delete or leave tombstoned |
| `app/api/wallet/seed/route.ts` | metadata read | migrate or confirm render-grain equivalent |
| `supabase/functions/scan-pinnacle-wallet/index.ts` | metadata read (edge fn) | migrate (mind the verify_jwt deploy hazard) |
| `app/blog/pinnacle-star-wars-day-2026/page.tsx` | one-off static blog | low priority / leave |
| `app/api/pinnacle-listings-indexer/route.ts` | **writer** (ASK ingest) | subject of ASK-unify (#1) |
| `app/api/pinnacle-listings-retry/route.ts` | **writer** (ASK retry) | subject of ASK-unify (#1) |
| `app/api/cron/pinnacle-metadata-backfill/route.ts` | **writer** (metadata) | keep while `pinnacle_editions` stays ingest staging |

Already on the render grain (`pinnacle_catalog`) — **no work needed**: `lib/concierge/{fmv-distribution,pinnacle-router}.ts`, `lib/sniper/pinnacle.ts`, `app/api/overview-stats`, `app/api/collection-stats`, `app/api/cron/pinnacle-wmc-render-id`, `app/pinnacle/moment/[id]/page.tsx`, `supabase/functions/compute-pinnacle-pack-ev`, `app/api/admin/backfill-pinnacle-catalog`, `app/api/smoke-test`.

### The duplicated ASK pipeline (the real live-systems issue)

Two independent, live writers maintain two ASK representations at two grains:

- **Legacy:** `pinnacle-listings-indexer` → `pinnacle_editions.ask_price` (327 live). Watched by trust metric **`pinnacle_ask_stale_hours`** (breach 3h).
- **Render:** the render-floor writer → `pinnacle_catalog.floor_ask` (2,144 live). Watched by **`pinnacle_render_floor_stale_hours`** (breach 30h) — and `floor_ask` powers the `ASK_ONLY` FMV + every public render/edition/set page.

The render floor is ~6.5× more complete (2,144 vs 327). The legacy ASK exists only
because it predates the render floor. **Unifying on the render floor removes a whole
live pipeline + a redundant pager**, but must not happen until the last legacy readers
(table above) move over, or those surfaces lose their ASK.

---

## Target end-state

- **One canonical read grain for Pinnacle: `pinnacle_catalog` (render).** All display,
  FMV, ASK, and portfolio reads resolve here.
- `pinnacle_editions` either (a) retired to a pure ingest-staging table (no user-facing
  reads; still fed by metadata/ASK ingest if useful), or (b) dropped once the ASK writer
  is retired and nothing reads it.
- **One ASK writer** (render-floor); `pinnacle_ask_stale_hours` retired or repointed.
- A **shared render-grain read view/RPC** that encapsulates the 1:many aggregation
  policy once, so no consumer re-implements it (mirrors the `collection_chains` pattern).

---

## Migration plan (phased, each phase independently revertible)

**Phase 0 — canonical read view (enabler).** Build one SECDEF read view/RPC,
`v_pinnacle_render_display` (or extend an existing catalog reader), that returns the
render-grain row a consumer should show for a given `render_id` *and* a
`legacy_edition_key`→representative-render resolver with an explicit aggregation policy
(e.g. "lowest floor render" or "sum of minted across renders" per field). Encapsulating
the 1:many decision **once** is the single most important derisking step. No consumer
change yet. Revert: drop the view.

**Phase 1 — migrate the ~8 legacy reads (Item #2).** One surface per commit, each
verified against live data (row-identical or intentionally-improved), behind the Phase-0
view. Start with the dead route (delete) and the metadata reads; finish with the
user-facing moment page (after resolving Open Q2). Revert: per-commit `git revert`.

**Phase 2 — unify ASK (Item #1).** Once no reader depends on `pinnacle_editions.ask_price`,
retire `pinnacle-listings-indexer`/`-retry`'s ASK write (or repoint it at the render
floor), and retire/repoint `pinnacle_ask_stale_hours`. Revert: re-enable the cron +
metric.

**Phase 3 — data cleanup (Item #3).** Decide the 152 unbridged fossils (drop, or leave
tombstoned — they have 0 live asks so either is safe) and the fate of `pinnacle_editions`
(keep as staging vs drop). Revert: restore from a snapshot table.

---

## Phase-1 execution log (2026-07-17, Trevor green-lit "proceed")

Started Phase 1. Reading the actual code of the remaining legacy reads changed the
picture — most are dead or writers, and the two genuinely-live ones are riskier than
the inventory implied:

- **SHIPPED — moment redirect-slug resolver** (`app/(collections)/[collection]/moment/[momentId]/page.tsx`).
  Removed its `pinnacle_editions.route_slug` fallback read. **Discovery:** `route_slug`
  does not exist on `pinnacle_editions`, `pinnacle_catalog`, **or** `editions` (verified
  live) — so that select always errored to null. Behavior-neutral (Pinnacle moments use
  the render-grain `/pinnacle/moment/<id>` page, not this resolver). One legacy read
  retired. **Out-of-scope issue surfaced:** because `editions.route_slug` is also absent,
  the resolver's *primary* lookup returns null for **every** collection today, so this
  route always falls through to the `/collection` redirect — a pre-existing site-wide
  moment-deeplink degradation to triage separately (not a Pinnacle-grain issue).

- **SHIPPED — deleted dead `app/api/pinnacle/listings/route.ts` + `__tests__/api-pinnacle-listings.test.ts`.**
  Confirmed dead (no live caller; sole UI consumer `PinnacleSniper` unmounted; `/pinnacle`
  redirects). Coverage-verified before pushing: full `npm run test:coverage` **EXIT=0**,
  ratchet still passing with margin (actuals 44.62/36.9/52.38/46.69 vs thresholds
  44.5/36.75/52.25/46.55). Two legacy reads retired total (this + the moment resolver).

- **NOT migrated — the two live metadata reads (verified structural blockers).** Both feed
  **wallet/portfolio metadata display**. Deep key-relationship analysis against the live DB
  (2026-07-17) found:
  - **`pinnacle_editions.id == edition_key` for the 351 bridged rows** (id is `text`;
    for the 152 unbridged rows `id` is a numeric string like "1027" and `edition_key` is
    NULL). So `pinnacle_editions.id` doubles as the legacy edition key for everything the
    render grain can reach.
  - **`external_id` is populated on only 31/503 rows and bridges to NO catalog key**
    (render_id/edition_id/shape all 0 matches). The single catalog bridge is
    `pinnacle_catalog.legacy_edition_key = pinnacle_editions.edition_key`.

- **DECISIVE BLOCKER (found by deeper verification — corrects an earlier draft of this
  doc that called `scan` "cleanly migratable"): the legacy `edition_key` grain is
  character-lossy.** `edition_key = royalty_code:variant_type:printing` is per-**set-pack**,
  not per-**character**. One legacy key maps to *many different-character* renders — e.g.
  `20CS-OEV2-PDRA:Standard:1` covers Mountain Banshee, Prolemuris, Direhorse, … .
  `pinnacle_editions` collapsed each key to **one arbitrary character**; `pinnacle_catalog`
  keeps them separate by `render_id`. Live proof: comparing each bridged legacy edition to a
  representative catalog render, **character_name differs on 303/351** and set_name on 55/351
  (variant matches, 0/351). So **neither** the current legacy read **nor** a
  catalog-by-`legacy_edition_key` read yields the *correct* character — the legacy value is
  arbitrary and a `DISTINCT ON` representative is a *different* arbitrary character. Only the
  specific `render_id` the wallet holds is correct, and that is exactly what the downstream
  `pinnacle-wmc-render-id` cron already resolves into wmc.

  Consequences per consumer (both now understood as **ingest-time rough-placeholder writers
  that the render crons correct**, not authoritative reads):
  1. **`scan-pinnacle-wallet`** — its `character_name`/`tier` write is already arbitrary for
     multi-character sets (a pre-existing data-quality wart), and the render-id cron corrects
     wmc afterward. A catalog-by-`legacy_edition_key` swap would be *equally* arbitrary → **no
     net win**; a *correct* migration needs per-NFT `render_id` at ingest, which the scan's
     `pinnacle_nft_map` (nft_id→edition_key only) doesn't have. → **not a repoint; drop the
     placeholder char write and rely on the render crons, OR add render_id resolution.**
  2. **`wallet/seed enrichPinnacle`** — same class, plus it keys on `external_id` (31/503, no
     bridge) so it's largely vestigial already; its `ask_price`-as-fmv is overwritten by
     `populate-pinnacle-wmc-fmv`.

**Net (Phase 1):** 2 legacy reads retired (moment resolver + dead route), coverage-verified.
The 2 remaining reads **cannot be safely repointed** — the legacy grain is character-lossy,
so any edition_key-based read (legacy or catalog) writes an arbitrary character; the correct
fix is a **data-architecture decision** (drop the ingest-time placeholder char/set writes and
rely entirely on the render-id crons, or resolve `render_id` at ingest) that changes a
portfolio path and needs live verification — **Trevor's call, not a mechanical migration.**
A Phase-0 aggregation view would NOT fix this (the problem is key identity, not aggregation).
ASK-unify (#1 / Phase 2) is independent of these reads and remains the highest-value,
lowest-ambiguity next piece (see Item #1).

## ASK-unify runbook (Item #1 / Phase 2) — verified, ready for Trevor to execute

This is the highest-value, lowest-ambiguity remaining piece and is **independent** of the
character-lossy blocker. Every fact below was verified live 2026-07-17. It is **not shipped
here** because retiring `pinnacle-listings-reconcile` auto-deploys on commit (Vercel route)
and Pinnacle ASK display/accuracy can't be verified from a headless environment — it needs
one authed-page check, which is a 2-minute step for you.

**Verified facts:**
- **Sole live reader of `pinnacle_editions.ask_price`:** `app/api/wallet/seed/route.ts`
  (`enrichPinnacle`) — and it's vestigial (keys on `external_id`, populated 31/503) and its
  `ask_price`-as-fmv is overwritten by `populate-pinnacle-wmc-fmv`. No display/FMV surface
  reads it (concierge, sniper, moment pages already read `pinnacle_catalog.floor_ask`).
- **Writer of `pinnacle_editions.ask_price`:** `app/api/cron/pinnacle-listings-reconcile`.
- **Writer of `pinnacle_catalog.floor_ask` (the keep):** the render floor-map writer
  (`pinnacle_catalog_set_floor_asks`), 2,144 live rows, monitored by
  `pinnacle_render_floor_stale_hours` — a **separate** metric/writer from the legacy path.
- **The two ASK metrics are distinct** (watch different writers): `pinnacle_ask_stale_hours`
  (legacy `pinnacle_editions.ask_price`, breach 3h) vs `pinnacle_render_floor_stale_hours`
  (render `floor_ask`, breach 30h).

**Pre-flight check (do first — the one thing this environment can't):** load an authed
Pinnacle surface that shows an ASK/floor (a `/pinnacle/moment/<render>` with a live listing,
the disney-pinnacle sniper) and confirm the number comes from `floor_ask`, not the legacy
`ask_price`. The code grep says it does; confirm visually before retiring the legacy writer.

**Steps (each reversible):**
1. **Drop the sole reader's dependency first.** In `enrichPinnacle`, stop returning
   `ask_price` as `fmv` (return `null`, or read `pinnacle_catalog.floor_ask` via
   `legacy_edition_key` if a seed-time ASK is still wanted). Ships on commit; low-risk
   (vestigial + overwritten downstream). Revert: `git revert`.
2. **Retire the legacy writer.** Disable the `pinnacle-listings-reconcile` cron-job.org
   entry (operator, cleanest — no code) *or* delete/no-op the route. Revert: re-enable.
3. **Retire the now-redundant pager.** Recreate `v_rpc_trust_health` without the
   `pinnacle_ask_stale_hours` row (the render floor stays covered by
   `pinnacle_render_floor_stale_hours`). DB migration, verifiable (`SELECT … FROM
   v_rpc_trust_health`), reversible from migration history.
4. **Optionally** stop the reconcile write but keep the table (park `ask_price` as-is) if you
   want to preserve the 327 legacy asks as a fallback during a soak.

**Ordering matters:** reader (1) → writer (2) → metric (3). Retiring the writer before the
reader would freeze the vestigial `ask_price` under the reader (harmless but sloppy); retiring
the metric before the writer would page on the writer you're about to stop.

**Rollback (full):** re-enable the cron, `git revert` the `enrichPinnacle` hunk, restore the
prior `v_rpc_trust_health` def. No data is destroyed (the legacy `ask_price` column stays).

## Risks & mitigations

- **1:many mis-aggregation** → the Phase-0 view fixes the policy in one place; every
  migrated consumer inherits it. Highest-risk if skipped.
- **ASK regression** on a surface still reading the legacy ask when Phase 2 lands → gated
  by Phase 1 completing first; add a pre-Phase-2 grep assertion that 0 reads remain.
- **Edge-function deploys reset `verify_jwt`→true** (documented hazard) → any edge-fn
  consumer migration (e.g. `scan-pinnacle-wallet`) must re-toggle `verify_jwt` off after
  deploy and re-probe.
- **wmc denorm**: Pinnacle wmc FMV is already render-keyed (`populate-pinnacle-wmc-fmv`),
  so portfolio surfaces are unaffected — but re-verify no wmc path reads
  `pinnacle_editions` before dropping it.

---

## Open questions for Trevor

1. **Keep `pinnacle_editions` as ingest staging, or fully drop it?** If the render-grain
   catalog can be fed directly by the studio-GQL sync (it already is:
   `backfill-pinnacle-catalog`/`pinnacle-sync`), the legacy table may have no remaining
   role once reads + ASK move. Dropping is cleaner; keeping is lower-risk.
2. **~~Two Pinnacle moment pages~~ — RESOLVED during this doc.** `app/pinnacle/moment/[id]`
   is the canonical render-grain display page (reads `pinnacle_catalog`, redirects numeric
   ids onto `render_id`). The nested `[collection]/moment/[momentId]` does **not** display
   Pinnacle — its `pinnacle_editions` read only resolves a route slug for a `redirect()`.
   So Phase-1's moment step is a low-stakes slug-resolver repoint (or drop the Pinnacle
   fallback branch), not a display migration. No decision needed from you here.
3. **Aggregation policy for 1:many** — when a legacy edition fans out to N renders, what
   should a legacy-keyed lookup show: the lowest-floor render, a representative, or an
   aggregate? This is the Phase-0 view's core decision.
4. **Priority vs other work** — this is correctness/cleanliness, not a user-visible bug
   today (the render grain already serves FMV correctly). Worth doing to kill the
   duplicated ASK pipeline + redundant pager, but not urgent.

---

## Appendix — regeneration SQL (read-only)

```sql
-- grain sizes + bridge shape
SELECT
  (SELECT count(*) FROM pinnacle_editions) AS editions,
  (SELECT count(*) FROM pinnacle_catalog)  AS catalog_renders,
  (SELECT count(*) FROM pinnacle_editions pe WHERE EXISTS
     (SELECT 1 FROM pinnacle_catalog pc WHERE pc.legacy_edition_key = pe.edition_key)) AS bridged,
  (SELECT count(*) FROM (SELECT legacy_edition_key FROM pinnacle_catalog
     WHERE legacy_edition_key IS NOT NULL GROUP BY 1 HAVING count(*)=1) x)  AS bridge_1to1,
  (SELECT count(*) FROM (SELECT legacy_edition_key FROM pinnacle_catalog
     WHERE legacy_edition_key IS NOT NULL GROUP BY 1 HAVING count(*)>1) x)  AS bridge_1tomany;

-- ASK duplication (legacy per-edition vs render floor)
SELECT
  (SELECT count(*) FROM pinnacle_editions WHERE ask_price IS NOT NULL AND ask_source='pinnacle_direct') AS legacy_ask_live,
  (SELECT count(*) FROM pinnacle_catalog  WHERE floor_ask IS NOT NULL) AS render_floor_live,
  (SELECT count(*) FROM pinnacle_editions pe WHERE pe.ask_price IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM pinnacle_catalog pc WHERE pc.legacy_edition_key = pe.edition_key)) AS unbridged_with_ask;

-- code consumers of the legacy grain (run from repo root)
--   grep -rlnE '\.from\("pinnacle_editions"\)' app lib supabase/functions | grep -v __tests__
```
