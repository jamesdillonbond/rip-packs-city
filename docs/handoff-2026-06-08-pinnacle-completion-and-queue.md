# Handoff 2026-06-08 — Pinnacle per-render COMPLETION wave + everything else still open

CONTEXT

This is the full remaining queue as of 2026-06-08 ~03:30Z, built from a fresh reader inventory (DB pg_proc scan + repo grep, both verified tonight). The per-render Pinnacle engine, history table (pinnacle_fmv_history, trigger-fed, seeded 1,794), waves 1-3, and the history-fn swap are LIVE; what remains is the LAST set of legacy pinnacle_fmv_snapshots readers, then retirement. Plus the gated DB queue and two decision items. Claude Code's direct file inspection wins over this doc on any disagreement — several grep hits below may be comments from prior swaps; classify each before editing.

ITEM 1 (P1) — the final legacy-reader wave (verified inventory)

DB functions still referencing pinnacle_fmv_snapshots (pg_proc scan, exact list):
- get_set_detail(p_collection_id, p_set_slug) — entity set pages. Display-affecting: swap Pinnacle branch to pinnacle_catalog per-render. Product call per the waves doc: set-level rollups should aggregate across the set's renders (min/median floor + FMV range), not a single blended number.
- get_wallet_moments_with_fmv(...) — wallet/collection browse. wmc already carries per-render FMV (Wave 1a) — this fn's direct legacy read is likely a fallback branch; swap or delete the branch so wmc's value is authoritative.
- holdings_summary(p_wallet) — portfolio totals. Same approach: read wmc's per-render values, drop the legacy join.
- bridge_pinnacle_fmv_to_main() + pinnacle_fmv_from_listings() + pinnacle_fmv_from_sales() + pinnacle_fmv_recalc_all() — the LEGACY WRITER cluster. Untouched until the readers above are swapped; then Item 2.
Note: each reader swap changes displayed prices — Trevor eyeballs a sample surface after each (the Kylo Ren Digital Display ~$277 vs set-mates $23-33 spread is the tell that per-render is live). Cowork can ship any of these fn swaps as migrations on request once you and Trevor settle each keying choice.

Repo files still matching pinnacle_fmv_snapshots (13; classify comment-vs-live before editing):
- LIVE readers to swap: lib/concierge/fmv-distribution.ts + lib/concierge/pinnacle-router.ts (the AI concierge's Pinnacle pricing path — KEEP the triple-key discipline; per-render render_id keying now supersedes it; concierge answers must quote per-render FMV), app/api/sniper-feed/route.ts (Pinnacle leg — verify whether the branch is dormant before touching).
- LIKELY DEAD: components/pinnacle/PinnacleSniper.tsx — its only mount was app/pinnacle/page.tsx which is now a redirect (ee8f584). Grep for other mounts; if zero, DELETE the component.
- Comment-only / already-swapped (re-tag the comment, no logic): overview-stats, collection-stats, fmv-recalc, pinnacle-listings-indexer, populate-pinnacle-wmc-fmv, market-analytics, app/api/pinnacle/listings (CC noted the legacy embed already dropped).
- Prose, leave: app/blog/pinnacle-star-wars-day-2026/page.tsx, lib/analytics/methodology.ts (update wording only if it claims set-level pricing is current).

ITEM 2 (P1, after Item 1 hits zero live readers) — retirement endgame
1. Re-run both inventories (pg_proc ILIKE scan + repo grep) and confirm ZERO live readers.
2. Remove the pinnacle_fmv_recalc_all() call from app/api/cron/pinnacle-sync/route.ts (keep the render engine + history trigger).
3. Tell Cowork to drop the legacy cluster — pinnacle_fmv_snapshots + the four legacy fns — as a single audit_ migration with count(*) verification + bodies captured for revert (destructive SQL stays Cowork-side with backups; do not DROP from CC).

ITEM 3 (GATED — the notifier fires ~4 PM 2026-06-08 when the sentinel crosses 250; it was 1,116 and decaying at last check) — DUPE1 then Tier-B
(1) DUPE1 canonical merge per docs/migrations/dupe1-merge-plan-2026-06-07.md — re-verify the gate + every count yourself; the pre-measured 666 dupe-vs-canonical tx collisions get DELETED before the repoint; backups before every destructive step. (2) Tier-B sales re-map per docs/handoff-2026-06-07-tier-b-sales-remap.md (incl. the 8:62 Giannis fix). Sequenced, never parallel.

ITEM 4 (DECISION, review session — do not force) — the FMV dispersion gate
docs/audits/fmv-low-quality-decomposition-2026-06-07.md has the full simulation: serial-band trimming unlocks only ~22 HIGH + ~63 MED of the 214-edition gate-bound cohort; 58% stay genuinely dispersed; IQR variant similar (~39 tight). The honest ceiling is ~40-95 promotions. Decide with Trevor whether that justifies touching lib/fmv-confidence.ts at all, or close the lever as working-as-intended. Unit test either way: 90:3069 Max Strus (raw CV 0.35, 167 sales, still LOW — a different binder worth understanding before any change).

ITEM 5 (OPTIONAL scoping, medium) — Minted-event capture for 100% future pack-dist coverage
The on-chain PackNFT carries no distId (your Cadence MCP verification 2026-06-08); it exists ONLY in the A.0b2a3299cc857e29.PackNFT Minted event. Scope: extend the pack-events-ingest worker (wrangler deploy; keep repo copy in sync) to also cursor Minted events, writing (pack_nft_id → dist_id) either directly onto matching pack_purchases rows or into a small map table the existing trigger pattern consumes. This makes every FUTURE pack sale dist-linked at event time regardless of open status (the rips bridge keeps covering history). Design first, ship only if the event volume/cursor cost is sane.

WATCH (no action unless they trip)
- dist 7800's EV snapshot is still 2026-06-06 (the stale-chip/EV-dash artifacts on its page heal when the EV queue revisits); if it is STILL 6/6 after 2026-06-09, check why the queue skips it.
- Saturday's RPC Pipeline Runs Cleanup run: fn is fixed; if it STILL fails, the entry's stored apikey is anon → fold a weekly-gated supabaseAdmin.rpc('run_weekly_db_maintenance') into /api/cron/prune-logs and tell Trevor to delete the REST entry. Do NOT widen the fn's grants.
- pack_purchases bridge is accruing organically (15,187 → 15,196 within hours of install) — no action, just don't "fix" the partial coverage.

GUARDRAILS (standard)
Direct-to-main, no branches/PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0). tsc + corruption-guard before push; smoke after deploy READY. Full-file replacements; brand tokens only; maxDuration cap 800s; one focused commit per item; concierge + sniper are sensitive pipelines — small diffs, verify live after each.

END STATE: every Pinnacle price surface (entity, wallet, portfolio, concierge, sniper) reads per-render; the legacy table + writer cluster is dropped; DUPE1/Tier-B executed clean once the gate opens; the dispersion lever explicitly decided rather than lingering; and (optionally) future pack sales self-link to their dist at event time.
