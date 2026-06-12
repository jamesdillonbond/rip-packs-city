# Handoff 2026-06-11 — offers best-offer resolution + edition-level raise + team-moment display

Plain text on purpose (iPhone-pasteable). Inline paths/identifiers only, no code fences.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape. Verify every file exists before editing; where this doc names a display surface, grep for the real one rather than trusting the name.

## Context

Already LIVE (no action): the on-chain offers indexers app/api/topshot-offers-indexer/route.ts + app/api/allday-offers-indexer/route.ts populate the offers table (offer_type edition|subedition|serial, status open|filled|cancelled, idempotent on offer_id; status actively flips — 647 cancellations + 466 fills in the last 24h, so an "open" row is genuinely live). The GQL edition_offers cache is written by app/api/cron/offers-sweep/route.ts. v_offer_sanity_flags reconciles the two. None of that changes here.

This handoff covers three decided items from the 2026-06-09 data-quality sweep (docs/data-quality-sweep-2026-06-09.md) and the ledger items OFFER-SANITY-RAISE + TEAM-MOMENT-DISPLAY (docs/overnight/ledger.md, Queued). All product calls below are Trevor-confirmed.

Offer scope taxonomy (Trevor, locked): offer_type is three nested grains — edition = applies to any moment in the edition; subedition = applies to any serial in that subedition; serial = only that one serial. Show ONE best offer: the single highest offer the subject is eligible for.

Schema facts verified read-only on 2026-06-11 (open offers): edition 5,341 rows — 0 carry serial_number, 0 carry moment_id. subedition 1,540 — 0 serial, 0 moment_id. serial 533 — ALL 533 carry serial_number, 482 carry moment_id. CONSEQUENCE: serial offers can be matched to a moment by (edition_id, serial_number); subedition offers CANNOT be attributed to a specific moment today (no subedition key stored). So the per-moment rule below is edition + serial in phase 1; subedition is deferred to an indexer change (Item 4).

## Item 1 — Per-moment best offer = eligible-max (edition + serial)

Why: a moment (a specific serial) qualifies for offers at multiple grains. The displayed best offer must be the single highest offer it is actually eligible for, not just the edition aggregate. A serial offer targeting that exact serial (special/area-code/birthday serials carry real premiums) can legitimately exceed the edition offer.

Where: the moment-level best-offer read path. Primary surfaces to grep and update: app/api/best-offers/route.ts, app/moment/[id]/page.tsx, app/(collections)/[collection]/edition/[slug]/page.tsx, and lib/seo.ts (JSON-LD offers). The current edition-cell source is get_edition_high_offer (edition_offers then badge_editions.highest_offer) — keep that for edition-grain, add the serial leg for moment-grain.

Rule:
- For a specific MOMENT with (edition_id, serial_number): best_offer = MAX over open offers of [ max where offer_type='edition' on that edition_id ] and [ max where offer_type='serial' AND serial_number = that moment's serial ]. One number, no floor.
- For an EDITION-level cell (no specific serial — edition page header, edition_offers): best = max open offer where offer_type='edition' ONLY. A subedition/serial bid does NOT set the edition floor (it does not apply to every serial).
- NO floor / NO filtering. Trevor: we never filter out offers — a $1 edition offer on a Common shows as the best offer if it is the best. Do not add a minimum.

Implementation note: read from the offers table (status='open') for the serial leg; it has offer_type, edition_id, serial_number. Cleanest is a small read RPC, e.g. get_moment_best_offer(p_edition_id uuid, p_serial int) returning the max across the two eligible grains, SECDEF service_role + postgres only (revoke anon/authenticated on create — the SECDEF default-grant footgun). CC may instead inline the query in best-offers/route.ts; either is fine.

Revert: git revert the commit. If a new RPC is added, DROP FUNCTION get_moment_best_offer(uuid,int).

## Item 2 — Edition-level edition_offers raise (the durable fix for the 14 blank cells)

Why: 14 TS editions currently show a blank "Best offer" while a real edition-wide on-chain offer exists (GQL never surfaced it). Examples: SGA Kingmaker $5,222 (1-of-1, no FMV), LeBron Supernova $5,000, Wilt Heroes of the Game $1,501. These were validated: all 14 are offer_type='edition', none have a higher subedition/serial offer lurking, all are live. Full list in docs/data-quality-sweep-2026-06-09.md.

Where: app/api/cron/offers-sweep/route.ts — after the existing GQL edition_offers upsert, add a GREATEST raise from the on-chain edition offers.

Rule: for each TS edition, edition_offers.highest_offer = GREATEST(existing highest_offer, max(offers.offer_amount_usd WHERE edition_id matches AND status='open' AND offer_type='edition')). NEVER clobber down (GREATEST guarantees the GQL value is never lowered; the raise only fills/raises when the on-chain edition offer is higher or the GQL value is blank). NO floor. Recurring — runs every sweep tick so it self-maintains as offers come and go (the indexer flips cancelled/filled, so a withdrawn offer stops being max next tick). This is additive: ~14 cells today, but the set churns.

Cleanest shape: a SECDEF fn raise_edition_offers_from_chain() doing the set-oriented UPDATE ... FROM (per-edition max edition offer) with the GREATEST, callable once at the end of the offers-sweep route. SECDEF service_role + postgres only; revoke anon/authenticated on create. CC may inline instead.

Companion monitor — land WITH the raise, not before: add a line to v_rpc_trust_health, metric 'offer_edition_gap_max_usd' = max gap_usd from v_offer_sanity_flags WHERE has_sub_serial = false AND flag = 'gql_blank_chain_has' (edition-grain only), breach_at e.g. 50. Scope it to edition-grain so it does not chronically page on the subedition/serial noise (the raw 174-flag count is ~79 percent subedition/serial and is out of scope). After the raise runs a tick this metric should drop to ~0; it stays a tripwire for a future genuine edition-level blank. Do NOT add the monitor before the raise job exists or it breaches immediately on the open $5,222 gap.

Revert: git revert the route commit; the raise is additive (GREATEST never lowers a value) so no data needs unwinding, but if you want the raised cells cleared, they re-derive on the next GQL sweep. If the SECDEF fn was added: DROP FUNCTION raise_edition_offers_from_chain(). Monitor revert: CREATE OR REPLACE v_rpc_trust_health without the offer_edition_gap_max_usd UNION row (capture the current viewdef via pg_get_viewdef first).

## Item 3 — Team-moment display (mirror Dapper Market) + one hydration gap

Why: TS moments with player_name IS NULL are team moments (sets: WNBA Skyline, Skyline, Squad Goals, Fit Check, Dynamic Duos, Champion's Path, Season Rewind, Clamps, WNBA Squad Goals). The subject is the team, not a player. Most already carry team_name + thumbnail_url (e.g. 254:8623 = team_name "Portland Fire", tier ULTIMATE, play_type "Reel", set "WNBA Skyline"); they only render wrong on a surface that assumes player_name. This pairs with Items 1-2 because a team moment with a best offer must read cleanly.

Dapper Market scheme to mirror (verified live on dapper.market 2026-06-09): team moments render "{team_name} {play_type}" in the player-name slot ("Washington Football Team Team Melt", "Denver Nuggets Rim"), parallel to player moments "{player_name} {play_type}", with the team logo as the visual.

Where: grep for player_name rendering on the moment/edition surfaces — app/moment/[id]/page.tsx, app/(collections)/[collection]/edition/[slug]/page.tsx, and any shared moment/edition card component (e.g. components/entity/*). RPC already builds team logos at call sites (see the team-slug-vocabularies convention — there are three non-interchangeable team-slug forms; reuse the existing logo helper, do not invent a new slugifier).

Rule: when player_name is null/empty, fall back to team_name + set/play descriptor + team logo. Never render a blank or nameless card. Edition title becomes the team + play type.

Hydration gap (NOT code — note for the catalog pipeline): edition 254:8622 (WNBA Skyline) is fully unhydrated (null team/tier/thumb) while its sibling 8623 hydrated, so the on-chain data exists — let topshot-catalog-backfill / ensure_topshot_edition_stub reach it on its next pass. Do NOT hand-fill team_name (each Skyline edition is a different team; only the on-chain read knows which). The 1,249 set/team-less no-player rows are inert UUID DUPE stubs (1 has an offer) — not display targets, leave them.

Revert: git revert the commit.

## Item 4 — Subedition grain (deferred, note only — do NOT build now)

To include subedition offers in the per-moment best (Item 1), two things are needed and neither exists yet: (a) topshot-offers-indexer must capture the on-chain subeditionId on the offer (today subedition offers store no serial/moment/subedition key — they roll up to the base edition), and (b) RPC must map each serial to its subedition. Until both exist, subedition offers cannot be attributed to a specific moment and are correctly excluded from the per-moment best. Flag for Trevor; not in scope for this handoff.

## Guardrails (repeat every handoff)

- Work directly on main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first, then commit and push there.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — anything higher sends the deploy to ERROR invisibly. offers-sweep should stay well under; do not raise it past 800.
- CRLF: do not string-replace-patch on Windows; use full-file writes or findIndex on split-line arrays.
- Run npx tsc --noEmit clean before pushing. After deploy, confirm the Vercel deployment reaches READY and the smoke test passes (the edition/moment best-offer assertion in app/api/smoke-test/route.ts is the relevant one).

## Expected end state

One or more commits on main, deploy READY, tsc clean. Item 1: a moment's best offer reflects the max of its eligible edition + serial offers (one number, no floor). Item 2: the 14 blank edition cells now show their real on-chain edition offer (SGA Kingmaker reads $5,222), v_rpc_trust_health.offer_edition_gap_max_usd drops to ~0 and stays a tripwire. Item 3: team moments render team_name + play type + team logo instead of a blank card. Item 4 stays queued. Do not touch FMV/pricing/ingest logic. No FREEZE in effect.
