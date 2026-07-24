# Handoff 2026-07-07 — sniper + analytics monolith refactors, rpc-data skill sync, small cleanups

## Context

Cowork shipped the whole 2026-07-07 offers/parallel program live today (HEAD at writing: `443b87a` + one docs commit after; all deploys READY): subedition-aware offers end-to-end (offers-sweep parallelID keying, indexer subedition keying, **3,602 open subedition offers re-keyed** onto `::` editions via tx-event recovery, `audit_20260707_offer_sub_backfill` = audit/revert map), **731 offer-only `::` editions cataloged** (circulation NULL → the daily 21:10Z circulation cron raises them; art via the subedition-aware art cron), scope-aware offer display fns, Floor stat removed, sales-history parallel attribution, parallel-aware deal-floor-serials (`c88bd16`), the Flowty-teardown re-scope (**api2.flowty.io is ALIVE — do not delete listing-cache/flowty-proxy infra**; CLAUDE.md corrected), and collection-page extraction Steps 3b+3c (`849cb9e`, `5d4422d`).

This handoff covers what genuinely needs local Claude Code work: the two remaining monolith page refactors, the rpc-data skill source sync, and two small verified cleanups. Skim `docs/overnight/ledger.md` (2026-07-07 entry + follow-ups 1–5) before starting. **Note for the nightly pass / editions-flat watchers: TS editions grew +746 `::` rows today (15 + 731) — deliberate catalog, canonical `setID:playID::subID` format, NOT a writer leak (hyphen-UUID sentinel unaffected).**

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

## Item 1 — Sniper page refactor (`app/(collections)/[collection]/sniper/page.tsx`, 1,832 lines — verified via wc -l)

Follow the proven collection-page pattern (Steps 1→3c, all shipped): first a view-state reducer (`lib/collection/view-reducer.ts` is the template — sniper gets its own `lib/sniper/view-reducer.ts`), then presentational extractions into `components/sniper/` (filter bar, then the deals table/cards region). Behavior-preserving, verbatim JSX, one extraction per commit, `npx tsc --noEmit` clean each step. The original findings are in `docs/audits/refactor-plan-monolith-pages-2026-05.md` (point-in-time — re-verify against the current file; the page has already shrunk from ~2,070 to 1,832).

- Revert: `git revert` per extraction commit.
- Verify: tsc clean, deploy READY, live smoke `/nba-top-shot/sniper` (feed loads, filters + sort work, deal links out).

## Item 2 — Collection-analytics page refactor (`app/(collections)/[collection]/analytics/page.tsx`, 2,174 lines — verified)

Same pattern. NOTE the May plan named `app/(analytics)/analytics/page.tsx` (~2,208) but that file is now 495 lines (already decomposed) — the remaining monolith is the **per-collection** analytics page above. Re-scope from the live file, not the May doc.

- Revert: `git revert` per extraction commit.
- Verify: tsc clean, deploy READY, live smoke `/nba-top-shot/analytics`.

## Item 3 — rpc-data skill source sync (offers model) + package rebuild

`docs/cowork-skills/rpc-data/SKILL.md` (48 lines, verified) has no offers section and predates today's per-printing offers model. Append a short block:

- `edition_offers` is PER-PRINTING since 2026-07-07: base pair rows = Standard; `setID:playID::subID` rows = that parallel's own `highest_offer`/`low_ask` (GQL sweep keys by `parallelID`; blending across printings was a bug — never re-blend).
- On-chain `offers.offer_type='subedition'` rows are keyed to the `::` edition (base fallback only when uncataloged); `audit_20260707_offer_sub_backfill` is the historical re-key audit/revert map.
- `get_edition_high_offer(uuid)` now returns 4 cols incl. `offer_scope` ('parallel'|'edition'); on `::` pages best offer = GREATEST(own printing, base edition-grain chain offer).

Then rebuild the installable package the established way (PowerShell, since Git Bash has no zip): `Compress-Archive` the `SKILL.md` at archive root → `docs/cowork-skills/rpc-data.skill` (verify the zip lists exactly `SKILL.md` at root). Commit both. Trevor installs via Save skill.

- Revert: `git revert`.

## Item 4 — small verified cleanups (optional, 10 min)

- `lib/media/momentVideoUrl.ts`: zero importers repo-wide (verified via grep during the 2026-07-07 Flowty audit; re-verify) — delete if still orphaned.
- `lib/ufc/ufcFlowty.ts`: its `ufc-sniper-feed` caller was deleted today; remaining caller is `app/api/ufc-listing-cache/route.ts` which is LIVE ingest (api2.flowty alive) — do NOT delete the lib; just confirm nothing else dangles.

## NOT in scope — deliberate decisions, do not action

- Listing-cache routes / `flowty-proxy` edge fn / `edition-floor` Flowty leg: LIVE production ingest (see re-scoped CLAUDE.md priority #1).
- `lib/cadence/make-offer-flowty.ts` + `lib/chains/flow/cadence/make-offer-flowty.ts`: Cart-gated (Cart is shelved-revivable) — Trevor's product call, not a cleanup.
- Loan-book analytics + all `flowty_*` tables: KEEP (2026-06-22 decision).

## Guardrails (repeat every handoff)

- Direct-to-`main`, no branches, no PRs. If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op). Re-verify push: `git rev-list --count origin/main..HEAD` → 0.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is 800s — higher sends deploys to ERROR invisibly.
- CRLF: no string-replace patches on Windows; full-file writes or `findIndex` on split lines.
- `git pull` first — Cowork pushed ~10 commits to main today; the local tree may also have unpulled state.

## End state

Sniper + collection-analytics pages decomposed like the collection page (each extraction its own revertable commit, deploys READY, pages smoke clean), rpc-data.skill rebuilt with the per-printing offers model, orphan lib removed — main green, no behavior change anywhere.
