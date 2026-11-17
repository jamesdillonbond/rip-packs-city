# Handoff — 2026-06-04 audit fixes (Claude Code)

Source: `docs/audit-2026-06-04-full-platform-health.md`. Develop on `main`, commit + push to `main`, run smoke after. Items are independent — ship in any order. Plain-text prompt below is iPhone-paste-ready (no code fences inside the prompt).

Priority: P0 (now) → R1. P1 → C1, C2, K1, K2. P2 → M-1/M-2/M-3, C3. P3 → C4–C8 polish.

---

## P0 — R1: fix the offers→moments FK that is blocking the hydrator (DB migration)

The `topshot-moments-hydrator` is failing on every run because `offers.moment_id` FK is ON DELETE NO ACTION and the hydrator deletes/re-keys `moments` rows that 64 offers reference. `moment_id` is nullable, so ON DELETE SET NULL is safe and lets the hydrator proceed (offer rows survive, just drop the moment link). Apply as a migration named audit_20260604_offers_moment_fk_on_delete_set_null:

ALTER TABLE public.offers DROP CONSTRAINT offers_moment_id_fkey;
ALTER TABLE public.offers ADD CONSTRAINT offers_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE SET NULL ON UPDATE CASCADE;

Verify after: SELECT confdeltype FROM pg_constraint WHERE conname='offers_moment_id_fkey'; expect 'n'. Then confirm topshot-moments-hydrator ok=true on its next 1–2 runs in pipeline_runs.
Revert: ALTER TABLE public.offers DROP CONSTRAINT offers_moment_id_fkey; ALTER TABLE public.offers ADD CONSTRAINT offers_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id);

---

## P1 paste-ready prompt (Claude Code)

Make four independent fixes on main and push, then run the smoke test.

1. Page-title brand duplication. The root metadata template in lib/seo.ts (line ~18) is '%s | Rip Packs City'. Two pages set a title string that already contains the brand, so it renders doubled (e.g. "Dashboard | Rip Packs City | Rip Packs City"). Fix by setting just the leaf title so the template adds the brand once: in app/dashboard/layout.tsx change the metadata title to "Dashboard"; in app/insights/layout.tsx change the metadata title to "Public Insights". Do not change lib/seo.ts. Verify the rendered <title> on /dashboard and /insights shows the brand exactly once. Revert: restore the prior title strings.

2. Login footer is missing a collection. app/login/page.tsx (around line 385) hardcodes the footer string "NBA TOP SHOT · NFL ALL DAY · LALIGA GOLAZOS · DISNEY PINNACLE" and omits UFC Strike (early-access correctly lists all five). Append " · UFC STRIKE" so it lists all five published collections. Revert: remove " · UFC STRIKE".

3. Delete dead Flowty-era workflow. Remove .github/workflows/ts-listing-ingest.yml and scripts/ts-ingest.js. Flowty shut down 2026-05-13 and the Top Shot listings-indexer was retired 2026-05-26; this */5 cron calls a dead path. Confirm no other workflow or route imports scripts/ts-ingest.js before deleting. Revert: git revert the deletion commit.

4. Delete dead flowty-proxy edge function. Remove supabase/functions/flowty-proxy and drop it from any supabase config/deploy list. Grep the repo for "flowty-proxy" first to confirm zero live callers (the Flowty teardown already stripped route usage). Revert: git revert.

After all four: run npm run smoke (or the smoke-test route) and confirm green.

---

## P2 — responsive / overflow (mobile)

Single prompt:

Fix mobile/tablet table overflow. (a) app/(collections)/[collection]/sniper/page.tsx ~line 1566: the deals table sets minWidth: 980 inside an overflow:auto parent — change to minWidth:"100%" (or gate the 980 behind a >=md check) so tablets 768–960px don't horizontally overflow. (b) components/packs/PackTable.tsx ~line 418: change min-w-[900px] to md:min-w-[900px] so sub-768px tablets fall to the existing sm:hidden card view instead of a clipped table. (c) app/(collections)/[collection]/market/page.tsx lines ~689 and ~714: drop or make responsive the fixed cell minWidth 110/180 under 640px. (d) Analytics overflow: app/analytics (page + its dashboard child components) shows a horizontal scrollbar even at ~960px desktop width — find the widest child (a table/flex row without wrap) and wrap it in a div with overflow-x-auto (don't widen the page). Verify no horizontal scroll at 390px and 768px. Revert: git revert.

---

## P3 — CX polish (lower priority, batch when convenient)

- C4: TS overview "TOP 5 SNIPER DEALS" shows several rows with a $0 ask + a discount %. Suppress or relabel rows whose ask rounds to $0 (e.g. require ask >= $1, or show "<$1"), so a sub-dollar common doesn't read as a broken $0 deal. (Also a symptom of inflated-common FMV — F-series.)
- C5: entity edition pages render a blank black box for editions with no thumbnail_url/video_url (~54% TS coverage). Add a branded placeholder/poster instead of an empty media box.
- C6: TS overview KPI cards + deals render blank for ~5s during load — add a loading skeleton/spinner like the insights surfaces have.
- C7: analytics Insider Signals (BETA) shows "Unknown moment · #N · —" for unresolved buybacks. Resolve the moment name + value, or hide unresolved events until they resolve.
- C8: analytics "● 1 pipeline stale" badge is visible to anon visitors. Decide: keep as transparency, or hide for non-admins.

---

## Operator (cron-job.org / no code)
- K3: dial "RPC FMV Recalc Force Stale" from 3,13,23,33,43,53 to 8,28,48 (sweep long done; verified safe 2026-05-30).
- N1: re-fire snapshot-institutional-wallets (curl -H "Authorization: Bearer $INGEST_SECRET_TOKEN" <fn-url>); consider moving its slot off the 06:00Z peak.
- K4: confirm/prune cron-schedule.md entries classify-acquisitions-multicollection, lock-check-batch, run-insider-detectors (documented, not seen live 48h).
