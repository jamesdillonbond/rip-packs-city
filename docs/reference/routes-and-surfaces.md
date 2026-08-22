<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## ⚠ THREE switches mean "live", and they are DESIGNED to disagree

**`collections.is_active` is NOT the public-visibility switch.** Read as one, it says the opposite of
the truth for any partially-launched collection, and acting on it takes a live public surface dark.

| switch | governs |
|---|---|
| `collections.is_active` (Postgres) | RLS-gated anon PostgREST reads, ~11 cross-collection rollups, the smoke freshness grader |
| `published` on the entry in `lib/collections.ts` | nav, collection switcher, footer links, the `/<collection>/*` tab routes |
| `*_PUBLIC` in [lib/launch-flags.ts](../../lib/launch-flags.ts) | the `/insights/<board>` page + its public JSON + its OG card, enforced in `proxy.ts` |

**A partial launch — insights board shipped, collection surfaces not — is a legitimate deliberate
state**, and as of 2026-08-22 it is the state BOTH `candy_mlb` and `panini_blockchain` are in:
`is_active = false` in Postgres while `CANDY_MLB_PUBLIC` and `PANINI_PUBLIC` are **both `true`**, so
both boards are reachable, indexed and in the sitemap.

⚠ **The DB flag is the one you find FIRST and it answers a DIFFERENT question.** Measured 2026-08-22
while ranking the disk-IO budget: `panini_squeeze_board` + the `candy_*` boards are **605 GB / 7.75% of
all database disk reads**, and `is_active = false` on both collections makes "unlaunched boards nobody
can see" the obvious conclusion. It is wrong, and a session came one step from filing it and
recommending both be dropped from `WARM_BOARDS`. **Anyone auditing cost, dead code or "unused"
collections walks into this.** The full go-live ordering for a partial launch is recorded in the Candy
paragraph of [chain-strategy.md](chain-strategy.md) — accurate, but buried where a cost audit will
never look, which is why it is restated here.

## Route structure

Feature pages live at `app/(collections)/[collection]/`. The layout at that level provides header, nav, and ticker — pages must NOT include standalone headers.

The `[collection]` dynamic segment serves all 5 published collections: NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, UFC Strike. Each collection's page set is its `pages: [...]` array in `lib/collections.ts`, but since the **2026-07-18 IA reorg** the TOP BAR renders `tabBarPages()` = `pages` minus `TAB_BAR_HIDDEN_PAGES` (`packs`, `pack-sniper`, `hot-floors`, `challenges`) — those stay registered pages so every gate, capability check, and collection-switch keeps working; only the tab bar hides them. Per-collection `pages` (verified 2026-07-18):

- **All 5 published:** `overview`, `collection`, `sniper`, `analytics`.
- **`market` + `packs`:** all except UFC (Pinnacle gained both in the IA reorg).
- **`sets`:** all except Pinnacle.
- **`pack-sniper`:** Top Shot + AllDay only.
- **`challenges` + `hot-floors` + `play`:** Top Shot only.

**How the folded pages are reached (IA reorg conventions):** the **Moments | Packs sub-toggle** (`components/collection/PackSubNav.tsx`) mounts under the Collection / Market / Sniper tabs and is URL-param driven — `?section=packs`, NOT nested routes, so sub-views stay deep-linkable and the parent tab keeps highlighting (the market page already owns `?view=` for grid/table, which is why the toggle uses `?section=`). "Moments" is relabeled "Pins" for Pinnacle. Top Shot's `play` tab is the **Play hub** (`play/` route dir) fronting Challenges, Fast Break, and Road to the Ring. `components/collection/FeatureTabGate.tsx` (used by `market/layout.tsx` + `sets/layout.tsx`) gates those routes for collections that don't list the page.

**Market vs Sniper split (Trevor, 2026-07-18): Market is EDITION-level (one row per edition; AllDay via RPC `get_allday_market_editions`; Pinnacle via the render-keyed live-listings source reusing `computePinnacleSniperFeed`), Sniper is SERIAL-level (individual listings).** Market defaults to Price ascending.

Top Shot's Fast Break and RTR (Road to the Ring) game features live at `fast-break/` + `road-to-the-ring/` route dirs — still not registry tabs themselves (they appear in no `pages` array; the `play` hub links to them). Entity/detail routes under `[collection]` (also not tabs): `edition`, `moment`, `set`, `series`, `player`, `team`, `pack`, `profile`. There is NO standalone `badges` tab — the page type lingers in `lib/collections.ts` but no collection lists it and `/[collection]/badges` 307-redirects to `/overview` (badges render inline on edition/moment pages via `get_edition_badges_unified`).

Other top-level surfaces:
- **Global catalog search (site-wide, added 2026-08-11)** — `components/search/GlobalSearch.tsx`, mounted in `GlobalSiteHeader`, backed by public GET `/api/search`. It is the site's FIRST real search: everything that existed before searched ONE column with an unindexed `ilike` (`/api/edition-search` = `player_name` only / limit 10; `/api/search-editions` = auth-gated, for the alert-create modal) or was a client-side `.includes()` over already-loaded rows. Both old routes still exist and are NOT the global index — don't wire new callers to them.
- `/share/[wallet]` — shareable collection card with OG image
- `/profile/[username]` — public profile. **Reads through `lib/profile/public-profile.ts` (`getPublicProfile`, React-`cache()` memoized), NOT an HTTP self-fetch.** Carries the **Follow button** (`components/profile/FollowButton.tsx`, added 2026-08-11) — the follows table + CRUD route + dashboard friend-activity feed had existed since Phase 4 with **zero callers**, so follows sat at 0 rows and the feed showed its empty state permanently.
- **`/profile/[username]/trophy-case` — the shareable trophy case (added 2026-08-14)**, with its own card at `/api/og/trophy-case/[username]`. Until then the ONLY trophy-case export was a PDF, and **a PDF cannot unfurl** — pasting one into X or Discord produces a file, not a picture. It reuses `TrophySlab` in `public` mode rather than drawing its own tiles, so a visitor arriving from a shared link sees the case the owner actually arranged. Both it and `/profile/<u>` are **pinned public** in `__tests__/proxy-is-public-path.test.ts` (with `/profile/edit` pinned gated as the mirror) — ⚠ if the auth wall ever swallows one it does **not** 404: `proxy.ts` 302s to `/login` and the crawler gets an HTML login page **at status 200**, so every naive "did it respond?" check passes. That is exactly how `/fonts/*.ttf` stayed broken for weeks.
- ⚠ **The RPC handle now DEFAULTS from the Dapper/Top Shot username** (`lib/profile/username-from-topshot.ts` + `lib/profile/claim-username.ts`, 2026-08-14). **A username is what creates `/profile/<username>` at all**, and before this only **4 of 20** signed-up collectors had one — so 16 had no public profile to flair or share, and every social feature downstream was dead by default (backfilled: **4/20 → 20/20**). The claim is deliberately conservative: **never overwrite** an existing handle, **never steal** one (a `23505` returns `"taken"`, it does NOT auto-suffix), and **never throw** — a failed READ is not an absent handle. `RESERVED_HANDLES` includes `edit` and `settings` because those are REAL static segments that would beat `[username]` in the route table.
- `/analytics` and `/analytics/wallets/[address]` — analytics dashboards. Source lives under the `app/(analytics)/` route group (the group name doesn't affect the URL, so `find app/analytics` misses it). Sibling dashboards: `/analytics/{sales,loans,fmv,packs,sets,pulse,listings,methodology,api}`. Distinct from the per-collection `analytics` tab at `/[collection]/analytics`.
- `/admin/*` — internal tools incl. `/admin/flowty-analytics` (RPC_ADMIN_TOKEN gated)

Selected API endpoints worth knowing about:
- `/api/edition-stats`, `/api/pack-roi`, `/api/collection-snapshot`, `/api/overview-stats`
- `/api/admin/prune-pipeline-runs` (POST, Bearer `$INGEST_SECRET_TOKEN`; daily cron)
- `/api/wallet-backfill[-allday|-pinnacle|-golazos|-ufc|-multicollection]` — fire-and-forget Cadence walks; `?force=true` to bypass `skip_cached`
- `/api/seed-wallet-refresh` — orchestrator; cron-job.org still calls every 6h but an in-route gate (2026-07-18 cost lever) executes only the `utcHour % 12 < 2` waves (effective 12h cadence). `?force=1` bypasses (used by the GHA backstop — load-bearing, do not drop); env `SEED_WALLET_REFRESH_EVERY_WAVE=1` disables the gate
- **`/api/search`** (public GET, added 2026-08-11) — global catalog search over player / set / team / edition-key / play-type, via SECDEF service-role-only `rpc_search_catalog(p_q, p_collection_id, p_limit)`; `lib/search/href.ts` builds the result hrefs (in the primary coverage gate — a wrong href 404s on click). Three durable constraints: (a) it **MUST apply the platform canonical-edition predicate** — `editions` stores the same Top Shot moment under two key conventions (int `setID:playID` AND a UUID pair), so without it every TS hit returns twice and `edition_count` roughly doubles (Lillard read 95 vs the canonical 65); (b) it joins `AND c.is_active`, because unpublished collections (`candy_mlb`, `panini_blockchain`) have no `/[collection]/…` routes and their hits 404 on click; (c) on RPC failure it returns **503, never a 200 with `results: []`** — an empty array is byte-identical to a legitimate "nothing matched", so an outage would render as "we have no such moment" (the failure-renders-as-data class). ⚠ **SUPERSEDED 2026-08-13 — the catalog DOES hold descriptive prose now, and search reads it.** This entry used to state that narrative queries ("game winner", "buzzer beater") correctly return zero because no prose existed. That is no longer true: `editions.description` carries the paragraph the Top Shot moment page renders, and `rpc_search_catalog`'s edition arm searches it in both the index-backed anchor and the multi-token combined text, with a **0.12 `via_prose` ranking boost** so a deliberate narrative query surfaces the moments that ARE game-winners above editions that merely contain the words. ⚠ **DO NOT CITE `lillard game winner` → "Damian Lillard — For the Win" AS PROOF THIS WORKS — that was a FALSE POSITIVE and it is how the claim survived review.** "For the Win" is a SET NAME containing the query words, so that result is set-name matching mistaken for prose matching. Measured 2026-08-13: `game winner` returns a For-The-Win set roster (Blocks included) and misses the two most famous Blazers game winners (`48:1652` Archive, `121:4255` Run It Back: Legacies) though both carry descriptions. ⚠ **AND THE "OUTRANKED / length-normalized trigram" EXPLANATION THIS BULLET USED TO GIVE WAS ALSO WRONG — corrected 2026-08-14, on the third diagnosis.** The description is not in the similarity expression at all; a graded prose boost was built, measured, and **changed nothing**; and `ts_rank` reads 0.076 for nearly every row, correctly, because ~297 moments mention "buzzer" once and are genuinely equivalent. **The real defect was `LIKE ALL (v_pats)` — an AND over every query token** — so one word the prose never uses annihilated the query: `lillard buzzer beater` returned **zero rows** while `lillard buzzer` returned `121:4255` at rank 6. **Fixed** (`audit_20260814_rpc_search_catalog_token_coverage`): a **3-or-more-token query may miss ONE token**, ranked by a `(tok_hit / v_n) * 0.60` coverage term so a full match still outranks a partial one; a 1- or 2-token query must still match every word, because relaxing there degrades `lillard buzzer` into every Lillard moment. Validated as a separate prototype first — all three narrative failures fixed (`lillard buzzer beater` → rank 6, `damian lillard buzzer beater` → rank 6, `lillard game winner` → `48:1652` rank 20), all three working ranks and every entity query unmoved. ⚠ **The residual gap is STEMMING, and it is not fixable by switching to FTS**: the prose says "game-winning" and "buzzer", never "winner" or "beater", and Postgres English stemming does **not** relate winner↔winning or buzzer↔beater — `websearch_to_tsquery` also ANDs its terms by default, so the "proper" answer recommended twice in the filings would have failed on the exact two moments that motivated the work. **The reliable query shape is a NAME plus a distinctive word**, which is now stated in `/api/search`'s `meta.note` and the concierge prompt. See `docs/overnight/inbox/2026-08-14T0310Z-narrative-search-is-outranked-by-set-names.md` (title now historical). ⚠ **Coverage is PARTIAL and that partiality is disclosed, not hidden** — **9,128 of 13,208** canonical Top Shot editions (**69.1%**, measured 2026-08-14 — it was 44.6% at ship on 08-13 and the daily `topshot-catalog-backfill` cron moves it, so **any figure here is a dated sample, never a constant**) and **0% on every other collection** (All Day's ingest is WAF-blocked; nothing else has a prose source). So a narrative miss is AMBIGUOUS — "no such moment" vs "no description for that moment" — and `/api/search` reads the **`edition_description_coverage`** view LIVE into `meta.coverage` + `meta.note`, which `GlobalSearch`'s empty state renders. **NEVER hardcode the percentage**: the backfill moves it every run (the Panini lesson). A failed coverage read omits the disclosure rather than stating a number it cannot substantiate. Indexes: `idx_editions_team_name_trgm` (team lookup 162→33ms) and `idx_editions_description_trgm` (partial `WHERE description IS NOT NULL`; the whole call got FASTER, 33→23ms, because the extra selective index narrows earlier). Both built CONCURRENTLY out of band. ⚠ **It has a SECOND consumer as of 2026-08-13: the concierge's `search_catalog` tool.** So the `meta.coverage`/`meta.note` contract is now load-bearing for two surfaces — the header search panel renders it, and the bot is required by its system prompt to state which case an empty narrative result is. Changing or dropping those `meta` fields silently removes the assistant's only means of telling "we have no description for that" apart from "no such moment".

Collection registry: `lib/collections.ts` (8 collections defined; 5 currently published).
Old flat routes redirect to the new nested paths.

---



---

## Preserved from the 2026-08-17 CLAUDE.md restructure

> These lines were condensed or dropped in CLAUDE.md when it was cut to fit the memory-file
> char limit. They are kept here verbatim so nothing is lost.

### Wallet backfill ad-hoc (force full re-walk)

```bash
curl -X POST 'https://www.rippackscity.com/api/wallet-backfill?force=true' \
  -H "Authorization: Bearer $INGEST_SECRET_TOKEN" \
  -d '{"wallet":"0x..."}'
```
