# Claude Code handoff — AllDay serial/jersey FMV parity (scoped project)

## Context
The one substantive remaining parity gap from the 2026-07-10 audit: AllDay lacks the per-serial + jersey-premium FMV layer that Top Shot has. This doc scopes it. It is a real project, not a quick backfill — Cowork verified the blocker below rather than shipping blind. HEAD ~ `bba40c2`.

Claude Code's direct file inspection wins over this doc on any disagreement.

## What TS has (the port target)
- `serial_fmv_estimate(...)` — fitted power-law serial multiplier + a 7-arg jersey overload; weekly pg_cron fits (`compute_serial_fmv_power_model` / `_multipliers` / `_jersey_model`). HIGH/MED editions only.
- Special-serial surfacing (#1 / jersey-match / perfect) already renders on AllDay moment/edition pages **structurally** — but the jersey-match leg needs `editions.jersey_number`, which AllDay lacks.

## Blocker 1 — AllDay `editions.jersey_number` is 0/6,190 (verified)
- TS is 12,296 populated; AllDay is **0**. No jersey source exists anywhere in the DB: not on `editions` (no metadata JSON col), not in `wallet_moments_cache` (no jersey col), not in `badge_editions` (cols verified — none carry jersey). It is not derivable from `editions.name`/`play_category` (0 AllDay names contain a `#NN`).
- Source of truth is the **AllDay moment metadata** (the player's jersey number is a moment trait). Ingest path: AllDay consumer GQL (`getMintedMoment` / edition metadata) — but that endpoint is **Cloudflare-WAF-blocked from Vercel egress AND from the topshot-proxy worker** (confirmed this session). So the backfill must run on the **residential path** (the same box that runs the "RPC AllDay Badge Ingest" Task Scheduler job via Atlas), OR via a metadata trait already captured by the badge/Atlas ingest if it exposes jersey.
  - **First step for CC:** check whether the Atlas AllDay editions API (`scripts/ingest-allday-badges.mjs` source) returns a jersey/uniform-number field per edition. If yes, extend that residential ingest to also upsert `editions.jersey_number` — cheapest path, no new egress. If not, a dedicated residential `getMintedMoment` walk keyed by edition is needed.

## Blocker 2 — density caveat (verified, sets the addressable set)
- AllDay 180d sales: 4,356 editions have any sales, but only **755 have ≥20 sales** and **913 have ≥15 distinct serials**. A serial-FMV power-law fit is only meaningful for that liquid tail (~750–900 editions), mirroring TS's HIGH/MED-only scope. Don't fit the long thin tail — gate on the same sales-count threshold the TS fit uses.

## Suggested build order (after Blocker 1 is unblocked)
1. Backfill `editions.jersey_number` for AllDay (residential ingest per above); verify coverage > ~50% of the liquid set.
2. Parametrize the TS serial-FMV fit fns by collection (they're currently TS-UUID-scoped) OR clone them as `_allday` variants; add the weekly cron at a staggered slot.
3. Wire the AllDay edition/moment pages' jersey-match special-serial leg to the now-populated `jersey_number` (the structural slots already exist).
4. Verify: a liquid AllDay edition page shows a fitted per-serial ladder + jersey-match serial with a premium, matching the TS treatment.

## Not worth doing (audit residue, documented decisions)
- **notFound doubled-title cosmetic** (`/nba-top-shot/team/ogs` etc. render "…| Rip Packs City | Rip Packs City"): the pages are already `noindex`, so it's invisible to search. The fix would touch the shared `lib/seo.ts` default title or the root title template (blast radius = every page title) for zero SEO gain — **accepted as-is, do not chase.**
- **UFC unmapped sales (~271)**: UFC is migrating off Flow; historical-completeness only — **won't-fix.**

## Guardrails
Direct to `main`, no branches/PRs. PowerShell `git`; verify `git rev-list --count origin/main..HEAD` = 0. `npx tsc --noEmit` before push; Vercel READY + smoke. Vercel Pro maxDuration cap 800s. Residential ingest changes touch the home-machine Task Scheduler flow — coordinate with the existing `scripts/*allday-badge*` scripts.

## Expected end state
AllDay `jersey_number` populated for the liquid set; serial-FMV + jersey-premium layer live on AllDay edition/moment pages; trust 16/16, security 0/0/0/0.
