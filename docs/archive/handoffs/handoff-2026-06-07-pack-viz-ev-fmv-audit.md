# Handoff 2026-06-07 — Pack page viz upgrade + pack-EV 100% contents coverage + FMV honesty close-out + cleanup wave

CONTEXT (read first)

Produced by the 2026-06-07 daytime Cowork audit session (full platform health + site walkthrough). Platform is green: security invariants 0/0, detect_stalled_pipelines empty, 20/20 deploys READY at HEAD e7e1e92, CI green. Nothing was shipped live by Cowork this session except a no-op TFP-WATCH watchlist INSERT (a 480m row already existed — left as-is). The planned "recover 18 NO_DATA editions via badge asks" migration was investigated and CANCELLED — see Item 5, it would have fabricated prices from troll listings. Everything below is route/.tsx/edge-fn work for Claude Code, in priority order. Trevor approved full scope for items 1-4 on 2026-06-07.

Coordination: the nightly pass won't touch files committed in the last 24-48h; the pack dist page was last touched 2026-06-06 (807a7da) and today's session touched profile/verify/rewards files — no collisions expected with this list. docs/FREEZE.md does not exist and is not needed.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

ITEM 1 (P0, page-layer) — Pack dist page math + honesty bugs
File: app/(collections)/[collection]/pack/dist/[distId]/page.tsx (verified ~1,272 lines)

1a. Tier-odds table uses the WRONG DENOMINATOR. Around lines 1228-1260: pctOfPool = remaining / totalUnopened, and packOddsLabel(remaining, totalUnopened, slots). totalUnopened is PACKS remaining (55 on dist 901), not pool entries — live page shows Common "596%" (= 328/55) and Rare "~1 in 5" (= 1-(1-2/55)^6). Both are wrong and user-visible. Fix: compute poolRemaining = sum over tiers of Number(remainingByTier[t] ?? 0) and use poolRemaining as the denominator in BOTH pctOfPool and packOddsLabel. Expected after fix on dist 901: Common 328/330 = 99.4% of pool, Rare 2/330 = 0.6%, rare odds/pack = 1-(1-2/330)^6 ~ 3.6% ~ "1 in 28". Keep the existing "approximate, assumes independent slots" caption.

1b. The tier-odds panel renders on packs with NO drop pool, using pack counts as if they were pool rows. Live example dist 8525: "FANDOM 234 / 804 100% —" where 234/804 are PACKS remaining/minted. That is fabricated-looking data. Fix: only render the pull-odds panel when there are actual pool rows (remainingByTier derived from pack_drop_pool / v20-metadata tier counts); otherwise omit the panel entirely — the existing "No drop-pool data indexed for this distribution yet" empty state under Top Pulls already covers the message.

1c. No-pool packs show a hard "$0.00 Gross EV / Net +$0.00" KPI (dist 8525) which contradicts the empty state below and reads as "this pack is worthless". When the latest EV row is a sentinel (edition_count = 0, or fmv_coverage null/0 with no pool rows), render Gross EV as an em-dash with subline "awaiting pool data" and suppress the Net line. Value ratio already renders "—" correctly.

1d. Slots-unknown text glitch: dist 8525 hero renders "FANDOM Pack pack" (the word Pack duplicated where "N slots" belongs). Find the hero slots label near the tier chip; when slots is null render nothing (or "slots unknown"), never the placeholder twice.

1e. Top Pulls set-name glitch: "Rookie Debut6" — the set cell concatenates set name and series with no separator (grid section renders them correctly as separate elements). Add the space/separator or drop series from that cell.

1f. Hero pack art is a black box on many packs: pack_distributions.image_url points at asset-preview.nbatopshot.com URLs that are now dead (verified dist 901's URL returns an empty 200/404 — fetch it yourself to confirm), and the PackThumb onError path leaves an empty panel. File also involved: the PackThumb component (imported by this page, rendered ~line 556). Fix: when image_url is null OR the img errors, render a 2x2 montage of the top-4-by-FMV pool edition thumbnails (the page already has the pool editions server-side) with a tier-colored gradient backdrop; fall back to tier gradient + title when the pool is empty too. Keep brand tokens — no hardcoded hex.

Verify (item 1): npx tsc --noEmit clean; deploy READY; on /nba-top-shot/pack/dist/901 the Common row shows ~99.4% and a real odds value; /nba-top-shot/pack/dist/8525 shows no tier panel, no $0.00 EV, no "Pack pack"; hero box never renders empty black.
Revert: git revert the item-1 commit (page-layer only, no DB).

ITEM 2 (P1, page-layer) — PACKVIZ-GRID: pack contents visualization upgrade (queued ledger item, approved today)
Files: components/entity/EditionsGridPaginated.tsx + the pack dist page above.
EditionsGridPaginated is SHARED by player/team/series/set entity pages and TeamChecklist (verified 7 importers) — gate all pack behavior behind a new optional prop (e.g. packMode) so entity pages are untouched.

2a. Top-5-by-FMV "hero strip" above the main grid: a horizontal strip of the 5 highest-FMV pullable editions (bigger art, FMV + hit% chip) — the "what am I chasing" view, the single best contents-at-a-glance upgrade.
2b. Split pullable vs exhausted: main grid = drop_weight > 0 only (already the data shape); add a collapsed "Exhausted / pulled out" section for drop_weight = 0 rows (count in the header, expand on click). Today exhausted editions are simply invisible, which understates what the pack USED to contain.
2c. Keep the existing FMV-coverage chip + sort controls exactly as-is.

Verify: tsc clean; deploy READY; entity pages (e.g. /nba-top-shot/set/..., /nba-top-shot/player/...) render identically (no packMode); dist 901 shows hero strip + collapsed exhausted section; mobile 390px: strip scrolls horizontally, grid stays 1-2 col with no right-edge bleed (use minmax(0,1fr), not 1fr — repo-wide mobile lesson).
Revert: git revert (page-layer only).

ITEM 3 (P1, edge fn — pricing-adjacent, fetch/keying only, NO pricing-math changes) — kill the UUID pool residual at the writer
Function: compute-topshot-pack-ev (live platform version ~v35+, repo copy synced at v21/f39761a lineage). Repo copy location: verify with a grep for compute-topshot-pack-ev under supabase/functions/ — keep repo + deployed copy in sync (deploy via supabase MCP/CLI; Cowork can also deploy it on request).

Problem, measured 2026-06-07: of 5,531 distinct active (drop_weight>0) TS pool editions, 903 are still keyed to inert UUID-dupe editions — and 736 of those sit in 124 dists REFRESHED AFTER v20 shipped, so the v20 "prefer int pair, hydration re-keys residuals via remap_pack_pool_uuid_key" path is not resolving them. UUID editions are unpriced, so they cap what's-inside FMV coverage (pack_ev_latest TS avg fmv_coverage_pct is 63.6; only 361/1172 packs at ~100%).

Fix (two parts):
3a. In the edge fn's editionExtKey path: when EDITIONS_QUERY returns set.flowId / play.flowID null, do a secondary searchEditions meta-fetch by the set/play UUIDs to resolve the int pair BEFORE keying the pool row (same approach as the buildEditionKey fix in app/api/ingest/route.ts, commit 9368ade — reuse its query shape via topshot-proxy). Only fall back to the UUID pair if the meta-fetch also returns null; count both paths in extra (int_pair_keys / uuid_fallback_keys / meta_resolved_keys).
3b. Probe why remap_pack_pool_uuid_key leaves the 736 behind (wrong key format? only runs on hydration ticks that never see these dists? silently erroring?). Read-only query to reproduce the cohort: pool rows joined to editions where external_id !~ '^[0-9]+:[0-9]+$' and last_refreshed_at >= 2026-06-06.

Budget caution: the v21 per-pack 20s fetch timeout exists because the remap made fetches ~2x heavier — the meta-fetch adds calls, so keep it inside the per-pack timeout and cache resolved pairs per run. Do NOT raise batch_size (throughput lever is the cron frequency, already 10/hr by Trevor — see pack-ev memory). Pricing math, EV formulas, sentinel behavior: unchanged.

Verify: pipeline_runs extra shows meta_resolved_keys > 0 and uuid_fallback_keys ~ 0 on new ticks; over ~2 days the 903 active UUID pool editions trend toward 0 and pack_ev_latest TS avg fmv_coverage_pct climbs from 63.6 toward 90+; no rise in time_budget_exceeded_after_fetch fails (currently ~19/180 runs daily, rush-window class).
Revert: redeploy the prior function version (platform keeps versions); repo git revert.

ITEM 4 (P2, bigger build — design freedom) — empirical "observed" pools for the 254 no-pool live targets
254 of 800 topshot_pack_ev_targets have zero pack_drop_pool rows (mix: 169 common / 37 fandom / 35 rare / 12 legendary / 1 ultimate, nearly all paid) — TS API returns no editions for them, so their pages show nothing inside and EV sentinels forever. But RPC has observed pulls: pack_rips -> moment_acquisitions reveals what ACTUALLY came out of opened packs.

Build: a generator (DB RPC + cron route, or fold into an existing hourly) that, for target dists with no api pool and >= 20 observed rips, writes pack_drop_pool rows with pool_source='observed', drop_weight = observed pull frequency. Never overwrite pool_source='topshot_api' rows; observed rows are additive and clearly labeled. Page: when pool_source='observed', show an "odds observed from N opened packs" caveat chip on the tier panel + What's Inside, and gate the EV verdict to neutral (observed-frequency EV is an estimate, not the official odds). Cowork can ship the migration/RPC half live on request — say the word and it lands with the usual audit_ tag + revert.

Verify: a handful of the 254 gain What's-Inside content with the observed chip; no target with an api pool changes; EV verdicts on observed packs render neutral.
Revert: DELETE FROM pack_drop_pool WHERE pool_source='observed' + git revert the page/route commit.

ITEM 5 (P1 as documentation, NO code) — TS FMV "100%": the honest close-out
Measured 2026-06-07 on the 9,135 canonical (int-keyed) TS editions: 100% have an FMV snapshot row. Mix: HIGH 543, MEDIUM 2,376, LOW 4,834, ASK_ONLY 1,011, STALE 149, SALES_ONLY 9, NO_DATA 213. The 213 NO_DATA all have ZERO lifetime sales (verified against the full sales history, not just 90d). 18 of them have a badge_editions.low_ask — but every single one is a troll/moonshot listing ($999,999, $500,000, $175,132, ... $1,050 — on editions that have never traded once). DO NOT auto-promote zero-sale editions to ASK_ONLY from a single ask, ever — it would stamp six-figure FMVs on dead editions (the exact catastrophic-error class from the LiveToken cross-check). NO_DATA is the honest, correct label and the pages render it cleanly. TS FMV coverage is therefore COMPLETE in the honest sense: 97.7% priced + 2.3% provably unpriceable. The remaining FMV lever is quality (LOW -> MEDIUM/HIGH via accumulating sales + the serial-residual gate), not coverage. Suggested one-liner for CLAUDE.md's next session entry so this doesn't get re-investigated.

ITEM 6 (P2, cleanup wave — small, all verified file:line)
6a. app/(collections)/disney-pinnacle/layout.tsx line 32: ticker copy "PINNACLE SNIPER — real-time Flowty listings sorted by price" is stale (Flowty died 2026-05-13; this renders in the LIVE ticker on every Pinnacle page — seen live today). Replace with per-pin FMV / live floor framing, e.g. "PINNACLE SNIPER — live floor + per-pin FMV".
6b. app/pinnacle/page.tsx: orphan Flowty-era standalone "Pin Sniper" page (verified zero inbound href="/pinnacle" links repo-wide; copy says "Browse live Flowty listings"; hardcoded hex colors #f1f5f9/#a78bfa violate brand tokens; mounts the legacy PinnacleSniper). Replace the file with a server redirect() to /disney-pinnacle/overview. Keep app/pinnacle/moment/[id]/ INTACT — the new pin pages live there and are public + in the sitemap.
6c. lib/seo.ts line 34: remove 'Flowty' from the global keywords array (still emitted in meta-keywords on every page).
6d. app/pinnacle/moment/[id]/page.tsx lines ~163-189: page titles append "| Rip Packs City" but the root layout template appends it again — live <title> is "Flo · Digital Display | Rip Packs City | Rip Packs City". Drop the suffix from the page-level titles.
6e. Same file, Edition details panel: materials/effects render raw JSON arrays — live page shows ["GOLD"] and ["LED GLITCH"]. Parse (they're jsonb/text arrays) and render as plain joined text or chips: GOLD, LED GLITCH.
6f. Optional: app/api/market-listings/route.ts is a Flowty-listings fetcher (header comment says so) — grep callers; if zero, delete the route; if called, make it return the TS-quote shape its callers expect or stub 410.

Verify: tsc clean; deploy READY; Pinnacle ticker shows new copy; /pinnacle 307s to /disney-pinnacle/overview; pin page title single-suffixed; edition details show GOLD / LED GLITCH as text; smoke suite green (52 checks).
Revert: git revert (single cleanup commit).

ITEM 7 (operator notes — not code, do not commit)
- Sentry: 5 unresolved issues are all smoke-test transients from the 06-07 ~07Z rush window; if quiet through ~07Z 06-08, mark all resolved (NEXTJS-4's fix 0320f92 shipped today).
- Pipeline Sentinel GHA is red on every run because the TS-UUID-48h leak tripwire reads 1,827 (>250 warn floor) — pure DUPE1 roll-off, decaying ~58/hr, should self-clear ~06-08; no action unless it plateaus.
- cron-job.org hygiene (carried from ledger CRON-30S): 4 entries still pass the INGEST token as ?token= in the URL — move to the Authorization: Bearer header field (routes already accept both since 9d35a48).
- TFP-WATCH: pipeline_cadence_watchlist row for topshot-fmv-populate exists at 480m (something shipped it before this session at the tightened value; ledger drafted 780m). If the ~6h cron drops a single tick, 480m will false-positive a stall — widen back to 780 with: UPDATE pipeline_cadence_watchlist SET max_silent_minutes=780 WHERE pipeline='topshot-fmv-populate'; (or accept the noise for a week then it's fine to keep 480).

GUARDRAILS (repeat every handoff)
- Commit and push directly to main. NEVER create feature branches, NEVER open PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines.
- Full file replacements, not diffs. Run npx tsc --noEmit before pushing; run the smoke test after the deploy reaches READY.

END STATE when this lands: pack pages show correct odds math, honest empty states, art in every hero, a top-5 hero strip + exhausted section; the pack-EV writer stops emitting UUID pool keys and what's-inside FMV coverage climbs toward ~100% on pooled packs; the 254 no-pool packs gain observed contents; Flowty is gone from all live copy; pin pages polish out; TS FMV coverage is documented as honestly complete at 9,135/9,135 labeled.
