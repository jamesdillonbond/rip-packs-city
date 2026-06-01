# Team Hub Build-Out — Research & Spec

**Date:** 2026-05-31
**Status:** Phase 1 SHIPPED 2026-05-31 (commit `0f65db8`, deploy READY). Phases 2–4 are planning. Scope: **NBA Top Shot first**, generalizes to NFL All Day + LaLiga Golazos.
**Author:** Cowork research pass for Trevor.

> **Phase 1 shipped (2026-05-31, `0f65db8`).** Live: branded team-colored hero + NBA-CDN logo + abbreviation/league chips (falls back to the plain hero when unbranded); `get_team_detail` v2 (teams_master branding matched on slugified `team_name` — no cross-league slug collision, no league guard needed — plus `sales_30d`/`volume_30d_usd`); `get_team_players` now surfaces `is_active`; 30d Sales + 30d Volume stat cells (strip is **7** cells — cost-to-complete is Phase 2); Current/All-Time roster toggle. Corrections folded in from the build: logo `onError` lives in a small `TeamLogo` **client island** (an RSC can't take `onError`); the gradient uses the real token **`--rpc-surface`** (`#0D0D0D`), not `--rpc-bg`; the Current toggle only renders when a loaded row has `is_active===true` (Pinnacle/NFL/Golazos `is_active` is null → all players show). Revert: `git revert 0f65db8` + `CREATE OR REPLACE` the prior D1/D2 bodies.

---

## 0. TL;DR

Standalone team pages **already exist and work** at `/<collection>/team/<slug>` — but they are a thin aggregation (5 stat cells + a Top Editions grid + an all-time player roster). This spec turns them into the **canonical team hub**: the page that ranks for "[team] Top Shot moments / checklist" and becomes home base for a team's collectors.

Three things make this worth doing now:

1. **White space.** Top Shot treats team as a *marketplace filter* (`/search`), not a standalone indexable page. Their **Team Checklists** (All-Time / Contemporary / per-Series) are a core collector loop but are locked inside the authed profile — invisible to search and to non-owners. MomentRanks/LiveToken are valuation/portfolio tools, not team hubs. Nobody owns the public "[team] hub."
2. **The data is already in the warehouse** — most of it unused by the current page. `teams_master` (colors, logos, abbreviations) and a current-roster table both exist but aren't wired in.
3. **It's an SEO multiplier.** ~139 team URLs are already in the sitemap; enriching them with checklist + cost-to-complete content gives each a reason to rank that Top Shot can't match.

This fits the platform thesis: intelligence-first, own the surfaces Top Shot won't ship, lean into squeeze/rookies/checklists.

---

## 1. Current state (what ships today)

| Piece | Location | Notes |
|---|---|---|
| Page route | `app/(collections)/[collection]/team/[slug]/page.tsx` | Server component, ISR `revalidate=600`. ~165 lines. |
| Detail RPC | `get_team_detail(p_collection_id, p_team_slug)` | Returns team_name, variants, is_franchise, player_count, edition_count, total_circulation, fmv_total_usd, floor_total_usd. **No branding fields.** |
| Roster RPC | `get_team_players(...)` → `/api/entity/team` | All-time players w/ edition_count, fmv_total, jersey, headshot_url, portrait_thumbnail. |
| Editions RPC | `get_team_top_editions(...)` → `/api/entity/team-editions` | Top editions, sortable, paginated 24/page. |
| OG card | `/api/og/team` via `lib/og/entity-card.tsx` | 2×2 montage + aggregate FMV stat. |
| Metadata + JSON-LD | `lib/seo.ts` → `teamPageMetadata`, `teamJsonLd` | SportsTeam / Organization schema, canonical, OG image. |
| Sitemap | `app/sitemap.ts` | Emits one URL per `collection|slugify(team_name)`, priority 0.55. |
| Labels | `lib/entity-labels.ts` | Sports = Team/Roster; Pinnacle = Franchise/Cast. |

**Live page sections (top → bottom):** breadcrumbs → text hero (name + merged-variants note) + small 5-thumb montage → 5 stat cells → Top Editions grid → Roster grid.

**What it does well:** correct aggregation, fast, consistent with the player/set/series entity pattern, fully sitemapped + JSON-LD'd, works across NBA / NFL / Golazos.

### Team URL coverage (from `editions.team_name`)

| Collection | Distinct teams | Editions | Editions w/o team |
|---|---|---|---|
| NBA Top Shot | 70 | 16,287 | 2,609 |
| NFL All Day | 40 | 6,191 | 37 |
| LaLiga Golazos | 29 | 581 | 0 |
| UFC Strike | 0 | 446 | 446 (no team concept) |
| Disney Pinnacle | franchises live in `pinnacle_editions` (separate table) | — | — |

≈ **139 sitemapped team URLs today** (70 + 40 + 29). The 70th "NBA team" includes a few non-team buckets (e.g. Team LeBron / Team Durant all-star squads, Rising Stars) — worth a cleanup pass.

---

## 2. The gap — current page vs. a true hub

What a "centralized hub for everything related to that team" is missing today:

- **No team identity.** Plain text hero. No logo, no team colors, no abbreviation, no league/division. Every team page looks identical.
- **Roster is all-time only.** The live Lakers roster mixes LeBron, Magic Johnson, Wilt Chamberlain, and Elgin Baylor with no "current vs all-time" distinction. The user explicitly wants a **current roster**.
- **No checklist.** The headline collector mechanic — "which moments do I own / am I missing for this team" — does not exist. This is exactly the "checklist like we see on the Top Shot Moment" the user referenced.
- **No cost-to-complete.** Top Shot shows owned/missing checkmarks but *not* the dollar cost to finish. RPC can, using FMV/floor.
- **No market activity.** No recent sales, 30-day volume, or "what's moving" for the team — even though it's a one-join query (1,599 Lakers sales / $18.8k in the last 30d).
- **No sets breakdown.** Which sets feature this team, and how close to completing each.
- **No scarcity/squeeze signals**, no tier-mix bar, no rookie spotlight, no pack cross-reference.
- **No personalization.** A `user_favorite_teams` table exists but there is no "Follow team" UI.
- **No live-game context.** `nba_games` + projections (incl. injury status) exist but aren't surfaced.

---

## 3. Data inventory — what we can build with *today*

| Source | Rows / shape | Powers | Caveats |
|---|---|---|---|
| `editions` (team_name, series, set_name, tier, badges[], reward_indicators[], thumbnail_url, video_url) | 16,287 NBA | All moments, checklists, sets, tier-mix, badges | ~62% TS thumbnail coverage; ~7K inert UUID dupes already filtered by entity RPCs |
| `fmv_snapshots` (latest per edition) | — | FMV/floor, cost-to-complete | Most TS editions STALE/LOW confidence — cost-to-complete must use floor + honesty labels |
| `teams_master` | **95** — league, slug, team_name, abbreviation, external_id, primary_color, secondary_color | Branding: colors, logos (NBA CDN via external_id), abbr, league | **Slug mismatch:** stores `"blazers"`; route uses `"portland-trail-blazers"`. Bridge by `slugify(team_name)`. |
| `players` (entity table) | team, jersey_number, position, is_active, headshot_url | Current-vs-all-time roster via `is_active` | TS headshot_url ~0% populated → fall back to edition thumbnail |
| `nba_players` | **174** — current_team_abbr, jersey_number, position, is_active_2026, headshot_url | Authoritative current-roster signal | **headshot_url empty (0/174)**; partial league coverage (~9–10 teams deep). Needs sync + backfill. |
| `sales` → join `editions` on edition_id | year-partitioned | Team activity feed, 30d volume, top movers, biggest sales | No team column; must join via edition_id |
| `wallet_moments_cache` (edition_key → editions.external_id) | — | Owned/missing for checklists when a wallet is connected/pasted | Join is text edition_key, not FK |
| `topshot_squeeze_board` (view) | 985 | Per-team squeeze ranking (lock+burn) | TS-only |
| `topshot_2025_rookie_players` | 61 (player_name) | Rookie spotlight on team pages | Name-match only |
| `nba_games` + `nba_player_projections` (injury_status) | 39 games / 455 proj | "Plays tonight" chip, injury flags on roster | Small/seasonal; sync cadence varies |
| `user_favorite_teams` (user_id, league, team_slug, is_primary) | 4 | "Follow team" personalization | Write path is auth-gated (behind login) |
| pack drop pools (`pack_drop_pool`, `get_pack_contents`) | — | "Which packs can pull this team" | drop_weight>0 filter required |

**Net:** sections 1–3 below (branding, current roster, checklists, sets, activity, squeeze) are buildable now with at most new read-RPCs. The only genuine *data* gaps are headshots and complete current rosters — both backfillable, neither blocking.

---

## 4. Proposed hub layout (Lakers as the worked example)

Top → bottom. Sections marked **[new]** don't exist yet; **[exists]** are live and kept.

### A. Hero — team identity **[new]**
Team-colored banner using `teams_master.primary_color` / `secondary_color` (Lakers purple/gold), official logo (NBA CDN: `https://cdn.nba.com/logos/nba/{external_id}/global/L/logo.svg`), team name, abbreviation (LAL), league chip, and a **"Plays tonight vs …" / record chip** from `nba_games` when in season. A **"★ Follow"** button (writes `user_favorite_teams`, auth-gated). Falls back to the current text hero for NFL/Golazos teams not in `teams_master`.

### B. Stat strip — extend **[exists → +3]**
Keep: Players, Editions, Total Mint, FMV Total, Floor Total. Add: **30d Sales** (1,599), **30d Volume** ($18,788), **Cost to Complete (All-Time, at floor)**.

### C. Team Checklists — the centerpiece **[new]**
Three tabs mirroring Top Shot's own structure, but public + priced:

- **All-Time Team** — every edition for the team (Lakers: 522; ~324 shown in the grid after the thumbnail filter).
- **Contemporary Team** — moments whose play happened in the **same season as the series they were minted in** — i.e. excludes throwback/historical sets (Archive, Run It Back, Vintage Vibes, Heroes of the Game). Computed as `season(game_date) == season(series)`, NOT a series cutoff. Lakers: **372 contemporary** (~238 with art). Verified the test isolates exactly the throwback sets.
- **By Series** — one checklist per series (Lakers S1 101 · S2 55 · S3 6 · S4 38 · S5 102 · S6 77 · S7 73 · S8 70).

Each checklist:
- Renders the full edition grid (great for SEO — indexable "complete the Lakers" content non-owners can see).
- When a wallet is connected **or pasted** (RPC's wallet-paste onboarding angle), shows owned/locked/missing states mirroring Top Shot's green/white/gray checkmarks (green = owned+locked, white = owned, gray = missing).
- Shows **completion %** and a **"Cost to complete: $X at floor"** bar — the thing Top Shot does *not* show. Per-tier breakdown ("Common $12 · Rare $340 · Legendary $4,900").
- Optional: replicate Top Shot's **Team Score** points (10k/20k/25k) so collectors can compare against the official metric.

### D. Current roster — current vs all-time **[new toggle on exists]**
Default to **Current** roster: active players (`players.is_active` / `nba_players.current_team_abbr` + `is_active_2026`) with jersey #, position, edition count, aggregate FMV, **injury status** chip (from projections), and a headshot (edition-thumbnail fallback until headshots are backfilled). Toggle to **All-Time** (today's behavior). "Current" answers the user's literal ask ("roster of the current players and their moments").

### E. All moments / Top Editions — keep + filters **[exists → +filters]**
Keep the sortable paginated grid. Add filter chips: **tier**, **series**, **badge** (Rookie / Championship / Top Shot Debut), **squeeze only**. This is the "all moments for that team" surface.

### F. Sets featuring this team **[new]**
Group team editions by set → set name, # team editions, completion %, cheapest entry. Links to the set page. (Mirrors the player page's derived "Sets" section.)

### G. Market activity **[new]**
Recent team sales feed (player, edition, serial, price, time), 30d volume sparkline, **top movers** (biggest FMV gainers), **biggest sales**. One `sales→editions` join.

### H. Squeeze & scarcity **[new]**
Team editions ranked by effective-supply squeeze (lock + burn) from `topshot_squeeze_board`. Ties into the existing `/insights/squeeze` surface; the team page becomes a per-team drill-down.

### I. Rookies & badges **[new, light]**
Rookie spotlight (`topshot_2025_rookie_players` ∩ team roster) and badge-filtered highlights (`editions.badges`). Cheap to add, strong collector hook.

### J. SEO / structured data — enrich **[exists → enrich]**
Enrich `SportsTeam` JSON-LD with logo, colors, `sameAs` (official team site), and add **FAQ schema** ("How many Lakers Top Shot moments are there?", "What does it cost to complete the all-time Lakers set?"). Tighten internal linking: player→team, edition→team, set→team backlinks.

---

## 5. Required RPCs / routes / migrations

All migrations follow the `rpc-migration` checklist (grant resets on CREATE OR REPLACE, `security_invoker` on public views, verify-rowcount-before-destructive).

**Data prep (Phase 0):**
1. **Slug bridge** — no schema change needed. In `get_team_detail` v2, `LEFT JOIN teams_master tm ON regexp_replace(lower(trim(tm.team_name)),'[^a-z0-9]+','-','g') = p_team_slug AND tm.league = <collection's league>`. This reconciles the `"blazers"` vs `"portland-trail-blazers"` vocab without touching `teams_master.slug`.
2. **`get_team_detail` v2** — add `primary_color, secondary_color, abbreviation, external_id, league` (from join), plus `sales_30d`, `volume_30d_usd`, `floor_to_complete_usd`. Same signature → grants preserved.
3. **Headshot/logo backfill (data task)** — cron via `rpc-sports-proxy` → `cdn.nba.com` to populate `nba_players.headshot_url` and verify `teams_master.external_id` → logo URLs. Non-blocking; roster renders with edition-thumbnail fallback until then.
4. **Current-roster completion (data task)** — extend the `nba_players` sync to cover all 30 teams (currently ~9–10 deep).

**New read surfaces (Phases 2–3):**
5. **`get_team_checklist(p_collection_id, p_team_slug, p_scope, p_wallet default null, limit, offset)`** — `p_scope` ∈ `all_time | contemporary | series_<n>`. Returns editions + (when wallet given) owned/locked flags from `wallet_moments_cache`. Route: `/api/entity/team-checklist`.
6. **`get_team_checklist_progress(p_collection_id, p_team_slug, p_scope, p_wallet)`** — owned count, total, completion %, cost-to-complete at floor, per-tier breakdown.
7. **`get_team_roster(p_collection_id, p_team_slug, p_current boolean)`** — extends `get_team_players` with an is_active filter + injury_status join. (Or add a `p_current` arg to the existing RPC.)
8. **`get_team_sets(p_collection_id, p_team_slug)`** — sets featuring the team + completion %. Route: `/api/entity/team-sets`.
9. **`get_team_activity(p_collection_id, p_team_slug, limit)`** — recent sales via `sales→editions`. Route: `/api/entity/team-activity`.
10. **`get_team_squeeze(p_collection_id, p_team_slug)`** — team slice of `topshot_squeeze_board`.
11. **Follow team** — `POST /api/teams/follow` writing `user_favorite_teams` (auth-gated; per safety rules this is a user-initiated write behind login).

**Frontend:** new components `TeamHero` (branded), `TeamChecklist` (tabbed, the big one), `TeamRosterToggle`, `TeamActivity`, `TeamSets`, reusing `EditionsGridPaginated` / `_shared` building blocks. Sitemap already emits team URLs — just bump canonical/priority and add the checklist sub-routes if they become their own URLs.

---

## 6. Phased plan

| Phase | Scope | Risk | Why this order |
|---|---|---|---|
| **0 — Data prep** | Slug bridge, `teams_master` join, logo/headshot backfill, roster completion | Low (read-side + cron) | Unblocks everything else; no UI risk |
| **1 — Identity + structure** | Branded hero (colors/logo/abbr), extended stat strip, current-vs-all-time roster toggle | Low | Immediate visual + SEO win; every team page stops looking identical; answers the "current roster" ask |
| **2 — The moat** | Team Checklists (All-Time / Contemporary / Series) with cost-to-complete; anonymous SEO version + wallet-connected/pasted tracking | Medium | The differentiated collector loop Top Shot keeps behind login |
| **3 — Depth** | Market activity, sets breakdown, squeeze, rookies, badge filters, packs | Low–med | Rounds out the "everything about this team" promise |
| **4 — Engagement** | Follow team, live-game chip, injury flags, completion alerts | Med (auth + live data) | Turns the hub into a return-visit surface |

Phase 1 is shippable on its own and is the recommended first increment.

---

## 7. SEO rationale

- **Target queries:** "[team] NBA Top Shot moments", "[team] top shot checklist", "complete all-time [team] set", "[team] top shot prices". These have collector intent and no strong incumbent — Top Shot's team content is behind auth; aggregators don't make team landing pages.
- **Unique indexable content:** the full checklist + cost-to-complete + activity is content that *only* RPC publishes. Thin aggregation pages don't rank; a priced, complete checklist does.
- **Internal link equity:** 1,297 NBA player pages and ~16K edition pages already exist — every one should backlink to its team hub, concentrating crawl + authority on ~70 high-value team URLs.
- **Freshness:** activity + checklist counts change daily → legitimate reason for crawlers to re-index (pairs with ISR `revalidate`).

---

## 8. Risks & caveats (be honest in build)

- **FMV staleness.** Most TS editions are STALE/LOW confidence right now (visible on the live page). Cost-to-complete must lean on **floor** with explicit honesty labels ("at current floor; X% of editions have stale pricing"), not imply precision we don't have.
- **Headshot gap.** `nba_players.headshot_url` is empty and TS player headshots are ~0% populated. Don't promise headshots in Phase 1 — use edition-thumbnail fallback and backfill in parallel.
- **Roster coverage.** `nba_players` is partial (~9–10 teams deep). "Current roster" via `players.is_active` is the safer near-term source; reconcile with `nba_players` as it fills in.
- **Slug footgun.** Two team-slug vocabularies (`teams_master.slug` vs route `slugify(team_name)`). Bridge on slugified `team_name`; do **not** assume `teams_master.slug` matches the URL.
- **Pinnacle.** Franchises live in `pinnacle_editions`, not `editions` — the sitemap team-URL generation (which reads `editions`) likely doesn't cover Pinnacle franchises today. Out of NBA-first scope, but flag for the all-collections pass.
- **"Team" noise.** The NBA team list includes all-star/rising-stars buckets; filter or label them so they don't render as malformed hubs.
- **Follow-team write** is auth-gated and a persistent-config write — keep it behind login and an explicit user action.

---

## 9. Open questions

1. **Contemporary definition** — RESOLVED (2026-05-31): a moment is Contemporary when `season(game_date) == season(series)` (the play happened in the season of the series it was minted in); throwback/historical sets (Archive, Run It Back, Vintage Vibes, Heroes of the Game) are excluded. Verified computable — game_date coverage is high for recent series (S7 ~99.6%, S8 ~92.6%); ~5–8% null-game_date editions are conservatively excluded. SQL in the Phase 2 handoff.
2. **Checklist tracking gate** — require login, or allow **wallet-paste** (no auth) to compute owned/missing? Wallet-paste matches RPC's onboarding angle and keeps the SEO page useful to anonymous visitors.
3. **Team Score** — replicate Top Shot's points (10k/20k/25k) for parity/comparison, or lead with our own cost-to-complete metric only?
4. **Cleanup** — drop the non-team "team" buckets (Team LeBron, Rising Stars) from team-URL generation?
5. **Cross-collection fan hub** — later, should `/team/...` roll up a fan's teams across leagues (NBA + NFL) via `user_favorite_teams`, or stay single-collection?

---

## 10. Appendix — verified figures (2026-05-31, prod DB `bxcqstmqfzmuolpuynti`)

- Lakers: 522 editions · 73 all-time players · 2,312,521 total mint · $38,135 FMV total · $39,333 floor total · 1,599 sales / $18,788 volume (30d).
- Lakers series split: S1 101 · S2 55 · S3 6 · S4 38 · S5 102 · S6 77 · S7 73 · S8 70. All-Time = 522 (~324 with art). Contemporary (verified `season(game_date)==season(series)`) = 372 (~238 with art) — throwback sets (Archive 112 / Run It Back: Origins 94 / Vintage Vibes 79 / Heroes of the Game / Supernova …) excluded; the test isolates exactly those sets.
- `teams_master`: 95 rows (NBA + NFL leagues), colors + abbr + external_id present. Sample: Trail Blazers `#E03A3E`/`#000000`, abbr POR, external_id 1610612757.
- `nba_players`: 174 rows; current_team_abbr + is_active_2026 populated; headshot_url 0/174; top teams ~17–20 players each (partial league coverage).
- `get_team_detail` returned no branding fields at research time (Phase 1 v2 has since added them).
- Top Shot Team Checklist tiers (from support docs): Team Series 10,000 pts · Contemporary Team 20,000 pts · All-Time Team 25,000 pts; checkmarks green=owned+locked / white=owned / gray=missing.

---

## 11. Cross-collection fan hub — /my-teams (Phase 5; handoff ready 2026-05-31)

**Premise.** `user_favorite_teams` is per-league (NBA / WNBA / NFL / LALIGA), so a logged-in fan holds e.g. Blazers + Liberty (both Top Shot) + Lions (All Day). An auth-gated `/my-teams` hub unifies them — the personalization capstone.

**Decisions (resolved 2026-05-31):** personal `/my-teams` only for v1 (no public "fans" page); auto-bind the user's saved wallet (`saved_wallets`, verified + most-recently-pinned) so completion shows without re-pasting; **WNBA included** — it is part of NBA Top Shot (`teams_master` already holds the 13 current WNBA franchises with branding, the Phase 1 join is league-agnostic so WNBA team pages are already branded, and Phase 4 follow already writes `league='WNBA'`).

**Shape.** New SECDEF `get_my_fan_teams()` (scoped to `auth.uid()`, authenticated-only) resolves each favorite's short slug → route slug + collection + branding via `teams_master`. The `/my-teams` page fans out to the existing `get_team_detail` + `get_team_checklist_progress` per team (≤4 typical) and renders a branded card each: completion % + cost-to-complete + "X locked" + 30d activity + link to the full hub. Mostly composition — one new RPC + one route + one page. Full build spec: `docs/handoff-2026-05-31-team-hub-phase5-fan-hub.md`.

**Deferred (optional):** a combined "recent activity across your teams" feed.
