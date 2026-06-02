# Handoff — Top Shot Packs: cheapest-secondary auto-sort (A) + clickability (B)

Plain-text, iPhone-pasteable (no code fences). Work on main, commit + push, tsc + smoke after. Each change has a revert. READ-ONLY review already done; all pricing data confirmed against prod DB bxcqstmqfzmuolpuynti. Brand: var(--rpc-red) / var(--font-display) etc — never hardcode #E03A2F or 'Barlow Condensed'.

Two product asks:
(A) Auto-sort the packs list by CHEAPEST SECONDARY pack price ascending. Context: the Road to the Ring (RTR) event has people buying the cheapest decent-EV pack just to check a daily-quest box, so cheapest-first with EV visible is the priority view.
(B) Make player / pack / set / edition names + thumbnails CLICKABLE to their entity pages.

CONTEXT — pricing data that already exists (do NOT rebuild):
- Each list row already carries displayPrice = live-overlay cheapest secondary ask, else cached secondary_ask, else retail. Computed in toPackRow in components/packs/PackPageClient.tsx (the displayPrice IIFE ~L189-196, and the live-overlay override ~L138-153). PackRow.displayPrice is already a field in components/packs/PackTable.tsx (~L59).
- Live secondary asks come from /api/pack-listings (Dapper Studio searchPackNftAggregation, TS + AllDay, 2-min cache) and are already overlaid via liveOverlayMap in PackPageClient (~L279-300). Cached secondary_ask comes from pack_table_rows.secondary_ask <- pack_ev_latest.secondary_ask.
- Coverage today: TS 774/1944 rows (40%) have a cached secondary_ask; AllDay 0/3052 (AllDay price is live-only). pack_purchases is NOT a usable per-dist price source — 100% of secondary_sale rows have pack_dist_id NULL. So displayPrice (live > cached > retail) is the right and only sort anchor. No DB change required for (A).
- PackTable's comparator already sends null/undefined sort values to the end regardless of direction (PackTable.tsx ~L358-361), so "cheapest first, packs-with-a-price ahead of priceless ones" falls out for free when sorting displayPrice asc.

------------------------------------------------------------
PART A — cheapest-secondary auto-sort

FILE 1 — components/packs/PackPageClient.tsx
- Add a new SortKey 'display_price_asc' to the SortKey union (~L18-26) and to SORT_OPTIONS (~L27-35) as { key: 'display_price_asc', label: 'Cheapest pack ($)' }. Put it FIRST in the array so it reads as the headline option.
- Change the initial sort state from 'value_ratio_desc' to 'display_price_asc' (~L219) — this makes cheapest-first the default view (the ask).
- 'display_price_asc' is a client-only sort (not in /api/packs ALLOWED_SORTS), so do NOT add it to SERVER_SORTS (~L243); leave SERVER_SORTS as the existing four. serverSort already falls back to value_ratio_desc for any non-server key, which is fine — the client re-sorts.
- In tableSortFor (~L549-565) add: case 'display_price_asc': return { key: 'displayPrice', dir: 'asc' }. PackTable already supports the 'displayPrice' SortKey and renders it as the Price column header (PackTable.tsx ~L95, L426), so the dropdown and the clickable column header stay in sync.
- Keep EV visible: no change needed — the Gross EV + EV Margin % columns already render per row; cheapest-first simply reorders. Optional one-line caption near the header (~L346-360): "Sorted cheapest pack first — EV columns flag a cheap +EV pack at a glance." Brand tokens only.
Revert: git revert; or set the initial sort back to 'value_ratio_desc' and remove the new SortKey/option/case.

WHY displayPrice and not retail: the existing 'Retail price (low->high)' sort maps to PackRow.price (retail), which is $0 for reward packs and ignores the live secondary ask — the wrong anchor for an RTR buyer hunting the cheapest BUYABLE pack. displayPrice is the price the user actually sees in the Price column.

OPTIONAL REFINEMENT (Trevor's call): for a strict "cheapest BUYABLE secondary first" semantic, sort by r.secondaryAsk asc with rows that have no secondaryAsk after (rather than displayPrice, which can interleave a retail-only/non-buyable pack among the cheap ones since primary_available=0 everywhere). displayPrice-asc is the pragmatic v1 (keeps a number on every row); secondaryAsk-asc is the purist RTR view. Ship displayPrice-asc first; tune if it ranks non-buyable packs too high.

EDGE CASES to verify after deploy:
- Reward/quest packs (retail 0, no secondary) get displayPrice null -> sort to the END (correct; not "cheap buyable packs").
- TS rows with neither live nor cached secondary (1170 rows) get displayPrice = retail if retail>0 else null. Acceptable.
- AllDay: displayPrice null unless /api/pack-listings returned a live ask that minute; on an empty live response AllDay rows mostly sort to the end — honest (AllDay is secondary-only, thin live depth; the existing "secondary market only" banner sets that expectation).

------------------------------------------------------------
PART B — clickability

FILE 2 — components/packs/PackTable.tsx
- Make the pack thumbnail clickable to the dist page, matching the title. Desktop row (~L448-458): wrap <PackThumb…/> in the same Link href={r.detailHref} used by the title (or wrap thumb+title in one Link). Mobile card (~L548-549): same. Use prefetch={false} like the title Link. Keep alt/aria intact.
Revert: git revert (remove the thumbnail Link wrappers).

FILE 3 — app/(collections)/[collection]/packs/simulator/[distId]/page.tsx
- The pool payload already carries edition_slug + player_name (interface ~L29-42) but nothing links. Add edition links using the confirmed pattern /${collectionSlug}/edition/${encodeURIComponent(edition_slug)} (URL-ENCODE — edition slugs are colon-keyed; un-encoded = guaranteed 404, the bf3f4f6 lesson):
  - Pull cards in PullsGrid (~L561-578): wrap each card (thumbnail + player name) in a Next <Link> to the edition page when pull.edition.edition_slug is set; plain <div> when null. Link already imported (L12). Keep the tier border + flip animation; Link as card wrapper with textDecoration:none, color:inherit.
  - CHASE card (~L378-389): only link the player name IF the /api/pack-simulator metrics payload exposes the max-pull edition slug. Verify the payload first; if the slug isn't present, leave as text (do NOT fabricate a slug). No API change in this pass.
Revert: git revert (unwrap the Links back to div/span).

FILE 4 — app/(collections)/[collection]/pack/dist/[distId]/page.tsx
- Top-pulls table: Player already links (~L853-859, good). The Set column (~L861) is plain text. Pick one:
  (a) LOWEST-EFFORT (recommended this pass): leave the text Top-pulls Set as-is and rely on the visual "What's Inside" grid above it (EditionsGridPaginated ~L772-801) whose edition tiles already link. The text table is a secondary "by EV" view; a non-linked Set there is acceptable.
  (b) FULL: add a set slug to fetchTopPulls (today it selects only editions(id,name,tier,external_id) ~L171 and splits name into player/set text). To link the Set, also fetch a set slug per edition (join editions.set_id -> sets) and render <Link href={`/${collection}/set/<set_slug>`}>. Small server-query change; only if (a) isn't enough.
Revert: git revert.

------------------------------------------------------------
NOT IN SCOPE (call out, don't do): persisting a "cheapest secondary ask per distribution" DB field. Not needed for (A) — /api/pack-listings already covers TS+AllDay live and pack_ev_latest.secondary_ask feeds the cached path. If later you want higher persistent TS coverage (>40%) or a non-live AllDay price, that's a separate Cowork-shippable RPC/MV keyed on (collection_id, dist_id) populated from the same Dapper Studio listings the EV cron already reads — NOT from pack_purchases (dist_id always NULL there).

CONFIRMED ENTITY URL PATTERNS (repo):
- Edition: /{collection}/edition/<encodeURIComponent(external_id or route_slug)>  (colon-keyed, MUST URL-encode)
- Player:  /{collection}/player/<player_slug>
- Set:     /{collection}/set/<set_slug>
- Team:    /{collection}/team/<slug>
- Pack dist:/{collection}/pack/dist/<dist_id>

QA AFTER DEPLOY:
- /nba-top-shot/packs loads with "Cheapest pack ($)" selected by default; rows ascend by the Price-column value; priceless/reward packs at the bottom; EV columns still visible; other sorts still work.
- /nfl-all-day/packs: cheapest-first where live asks exist; banner still present; no crash on empty live listings.
- Pack thumbnail click -> dist page (desktop + mobile).
- Simulator: rip a pack, click a pull card -> lands on /<collection>/edition/<slug> (no 404; confirms encodeURIComponent).
- Brand tokens only; no hardcoded hex/font. tsc clean; CI + smoke green; deploy READY.

END STATE: Packs tab defaults to cheapest buyable pack first with EV beside the price (the RTR daily-quest view); pack thumbnails + simulator pull cards/CHASE (+ optionally top-pull sets) are clickable into their entity pages. All frontend; no DB migration required to ship.

KEY FILES (absolute):
- app/(collections)/[collection]/packs/page.tsx — route wrapper
- components/packs/PackPageClient.tsx — list controller, sort state, displayPrice + live overlay (EDIT for A)
- components/packs/PackTable.tsx — table/card renderer; title links, missing thumbnail link, displayPrice sort already supported (EDIT for B)
- app/api/packs/route.ts — reads pack_table_rows; default sort value_ratio_desc; 4 server sorts only
- app/api/pack-listings/route.ts — live Dapper Studio secondary lowestAsk per dist (TS + AllDay) — the cheapest-secondary source
- app/(collections)/[collection]/pack/dist/[distId]/page.tsx — dist page; Top-pulls Set is plain text
- app/(collections)/[collection]/packs/simulator/[distId]/page.tsx — simulator; pull cards/CHASE not clickable despite carrying edition_slug
- components/entity/EditionsGridPaginated.tsx — clickable edition tiles (already used in "What's Inside")
