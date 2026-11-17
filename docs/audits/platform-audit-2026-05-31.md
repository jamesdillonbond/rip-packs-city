# RPC full-platform audit — 2026-05-31 (Cowork)

Cross-surface health + audit sweep: threads/ledger, DB + security, pipelines/cron, GitHub Actions, Vercel, Sentry, scheduled tasks, Cowork artifacts, the live website (Chrome), edition-offer display, new-user onboarding, brand standards, mobile, and cross-page wiring.

Prod at audit time: `dpl_6xk89SzM...` (commit `61fd1e6`, WNBA-logo render fix), READY. No `docs/FREEZE.md`. Heavy 5/31 ship day (Team Hub Phases 1–5, `/my-teams`, `/share` wallet-intel, `/insights/market`, badge-sync on-chain-key fixes, FMV ask-over-WAP `65421e26`, funnel-track `await` fix `2339f30`).

---

## TL;DR

The platform is **healthy and the heart of the offers ask already works** — where Top Shot publishes an edition offer, RPC displays the correct **highest** standing bid on both moment and edition pages (verified live: LeBron "Cosmic" shows `BEST OFFER $5,000` / `TOP SHOT ASK $25,000`, exactly matching the DB). Security is clean (0 RLS-off base tables, 0 anon-write holes, 0 dangerous anon-SECDEF), no pipeline stalls, 20/20 recent deploys READY, FMV improving.

The real work is a handful of **CX / trust / polish** items, all code-side (Cowork can't push code → packaged as a Claude Code handoff: `docs/handoff-2026-05-31-audit-followups.md`):

1. **P1 — fake offers on the logged-in collection grid.** `/api/best-offers` returns hash-randomized fabricated bids ($1–$26, random "Top Shot/Flowty" source) with zero DB/API call. Real allowlisted users see made-up numbers.
2. **P1 — onboarding funnel leak.** Marketing-home collection tiles link anon users to the auth-gated `/<collection>/overview` → they hit `/login` at the click. (The *primary* wallet-paste funnel is already fixed.)
3. **P2 — moment-page mojibake.** Empty-cell placeholders render as `â` instead of `—` and separators as `Â·` (21 corrupted bytes in `app/moment/[id]/page.tsx`).
4. **P2 — mobile overflow** on entity detail pages (fixed 2-col hero grids, no media queries) and 3 insights *tool* pages (un-wrapped tables).
5. **P3 — brand bare-literal cleanup** (collection layout, share card, profile/legal pages) + missing `public/home-fmv-preview.png` + smoke-suite cron-rush cry-wolf.

Nothing required a risky live DB change. Shipped live this pass: `.gitignore` guard for the overnight `.lock`, this report, an updated ledger, and a consolidated health dashboard artifact.

---

## 1. Health — verified clean (on the record)

| Surface | Result |
|---|---|
| **Security (catalog SQL)** | 0 RLS-off public base tables (173 total); 0 anon/authenticated INSERT/UPDATE/DELETE grants on RLS-off base tables; 0 dangerous anon-callable SECDEF write fns (only `resolve_moment_id(text)`, a read-only resolver, name-matched). |
| **Pipelines** | `detect_stalled_pipelines()` = `[]`. All `ok=false` in the trailing 8h are single transient midnight cron-rush / Base-429 failures with same-tick recovery (`pack-events-ingest`, `wmc-fmv-populate`, `evm-transfers-ingest`). |
| **FMV** | Writers fresh (<16m) on all 4 collections; TS HIGH+MED ↑ to ~852, NO_DATA ↓ to ~5,249, ASK_ONLY stable (intended `65421e26` ask-over-WAP). |
| **Sentinel** | TS-UUID-48h leak **190** — under the 250 ok-line, down hard from 1,099 baseline. |
| **Vercel** | Current prod READY; last **20/20** prod deploys READY, **zero ERROR**. |
| **Sentry (3d)** | Only **3** unresolved, all `POST /api/smoke-test` cron-rush transients (see P3-c). No app-path errors. |
| **Scheduled tasks** | 9 tasks, all enabled/firing (monitor, nightly pass, weekly health ×2, candy audits 6/22 + 7/8, phase-D/F closeout 6/1, monthly memory). |
| **Cowork artifacts** | 10 artifacts; all backing views/RPCs validated by the morning monitor sweep. |

---

## 2. Edition offers — the headline ask

**Ask:** "make sure the highest edition offer is displayed on moments with edition offers in place."

**Verdict: the display logic is correct; coverage is the limitation, and there's one trust bug.**

### How it works
`get_edition_high_offer(edition_id)` (SECDEF, read-only) → reads `badge_editions.highest_offer` (a single scalar = Top Shot's published top standing bid for the edition) + `low_ask` → both `app/moment/[id]/page.tsx` and `.../edition/[slug]/page.tsx` render it as the **"Best offer"** StatCell. Because the source is a single scalar, there is **no min/first/arbitrary selection bug** — the value shown *is* the maximum. **Verified live** on `/nba-top-shot/edition/8:133`: `BEST OFFER $5,000` matches DB `highest_offer=5000` (updated 22:07Z, "6 hours ago").

Source is **live** (Top Shot public GQL `highestOffer` via `/api/badge-sync`, last write 2026-05-31 22:07), so this is NOT frozen by the Flowty teardown.

### Gaps (none is a display bug)
- **Coverage (P2).** Only **2,087 of 16,293** TS editions carry a positive offer, because `badge-sync` walks only badge-tag-gated editions. Other collections: **0** (AllDay/Golazos have rows but null offers; UFC/Pinnacle have no `badge_editions` rows). So many editions that *do* have a live Top Shot offer show `—`. Fix = a broadened offer sweep (handoff item 2), not a render change.
- **Trust bug (P1).** `/api/best-offers` is a **mock** — it hash-seeds `momentId` and returns a random $1–$26 number with a random "Top Shot Edition / Top Shot Serial / Flowty Serial" source, **no DB or API call** (`app/api/best-offers/route.ts:33-68`). It's consumed by the logged-in collection grid (`app/(collections)/[collection]/collection/page.tsx` `enrichOffers`), so real users see fabricated bids (and a "Flowty" source that's dead). Fix = repoint to the real `badge_editions.highest_offer` (or remove the column). Handoff item 1.

### Dead offer infrastructure (cleanup, do-not-use)
- `marketplace_offers` — **585,341 rows but frozen Flowty history**: states only `LISTED`/`CANCELLED`, last event 2026-05-16, last ingest 2026-05-18, **`edition_id` NULL on every row** (keyed by `nft_id`), only consumer is `extract_flowty_offers`. Do **not** point the offer RPC at it (stale, cancelled, edition-less). Teardown candidate (keep frozen per the Flowty-history decision; do not auto-drop).
- `offers` table — **0 rows**, never populated (an abandoned trade-matching design). Drop candidate once confirmed unreferenced.
- `app/api/moment-offers/route.ts` — a *real* TS `getTopOffers` fetcher with correct `Math.max`, but **dead code** (no callers). Could back a real per-serial offer feature later.

---

## 3. New-user onboarding

**Mostly clean.** `proxy.ts` is sound (bypass-token first → public-path allowlist → allowlist-cookie → fail-closed `check_email_allowed`). Public surfaces (`/`, `/login`, `/insights/*`, `/moment/*`, `/share/*`, singular entity pages, `/api/wallet-search`, `/api/collection-snapshot`) are correctly open. Login error states (`access_revoked`, `allowlist_unavailable`) have real copy; `/my-teams` and squeeze board have proper empty states.

- **P1 — secondary funnel leak.** Marketing-home collection tiles → `href={/${c.id}/overview}` (`HomePageMarketing.tsx:452`) and the JSON-LD SearchAction → `/nba-top-shot/collection?username=…` (`:308`). Neither `/overview` nor `/collection` is in `isPublicPath`, so an anon click → `/login`. Same dead-end at `login` footer + the `(collections)` 404 layout. Fix options (handoff item 3): repoint tiles to a public destination (e.g. `/insights` or `/share`), or open `/<collection>/overview` GET/HEAD to anon.
- **P3 — primary wallet-paste funnel is FIXED** (verified). Home search routes a Flow address straight to public `/share/<wallet>`; usernames resolve via public `/api/wallet-search`. The prior P0 is gone.
- **P3 — copy/cosmetic.** Home advertises "No signup required" / "FREE DURING BETA" while sign-in enforces a closed-beta allowlist (waitlist). Home `STATS` are hardcoded ("100% Uptime", "9.5K+ Data Refreshes", `// TODO: wire`), and the "LIVE FMV PREVIEW" is a hardcoded mock referencing a **missing `public/home-fmv-preview.png`** (confirmed absent). Polish, not blocking.

---

## 4. Mobile

Public **insights boards** (index/squeeze/market/rookies) and the **moment page** are genuinely well-built for ~390px (clamp() headings, fluid `viewBox` SVGs, grids collapse, tables wrapped). Breakage is concentrated and specific (handoff item 4):

- **Entity detail pages** (`edition`/`player`/`pack/dist`/`team` `[slug]`) have **zero media queries** + fixed `gridTemplateColumns: "minmax(0,320px) 1fr"` heroes → horizontal overflow inside the 24px-padded collection chrome.
- **`player/[slug]` "Top Sales"** 6-column grid (~560px min) has **no `overflow-x` wrapper** → page-wide horizontal scroll.
- **3 insights *tool* pages** render bare `<table>` with **no `overflow-x` wrapper** (`insights/pack-reality:211`, `insights/tc-report` ×3, `insights/squeeze-check:191`) — unlike the *board* pages, which wrap.
- Lower: `edition` "Special Serials" fixed 4-col grid; stacked sticky chrome (ticker+breadcrumb+header+switcher+tabbar + bottom MobileNav) eats mobile viewport.

*Note:* live mobile-viewport screenshotting was unreliable in this session (the browser window resize didn't constrain the page viewport — shots rendered desktop-width), so the above rests on the code-level analysis (specific fixed grid templates + absent `@media`), which is high-confidence and actionable.

---

## 5. Brand standards

New surfaces (Team Hub `/my-teams`, all `/insights/*`, `components/entity/Team*`) are **clean** — tokens throughout. The `var(--rpc-red, #E03A2F)` token-with-fallback pattern (~280 uses) is fine. The backlog is **bare literals** (no token) in older chrome: `app/(collections)/[collection]/layout.tsx` (wraps every collection page — highest traffic), `app/share/[wallet]/page.tsx` (public funnel card), the Pinnacle static layout/collection pages, `player/[slug]`, profile + legal/marketing pages, and several component literal-consts. Legitimate exceptions confirmed correct: OG/Satori routes, email HTML, SVG `stroke`/`fill` (can't read CSS vars), `lib/collections.ts` `accent` (brand data), `ConsoleGreeting`. Low severity; handoff item 5 (polish).

---

## 6. Cross-page wiring

Spot-checked live + via code. `/insights/pack-reality` renders fully (130,507 rips, mean $6.21, median $0.34, full distribution, Top-10 +EV ranker) — it only *looked* empty mid-client-load; it's correctly wired. Edition pages render breadcrumbs + JSON-LD + parallels + special-serials. Team Hub nav + collection chrome render. Known data-quality tails (not new): a few low-mint editions show blank hero art (dead/again-null CDN thumbnails, e.g. LeBron Cosmic) and one `badge_editions` UUID-orphan row carries a garbage `low_ask` ($3,333,333) — the UUID-key orphaning tracked in memory, partially fixed 5/31.

---

## 7. Shipped live this pass (Cowork-safe)

- `.gitignore` — ignore `docs/overnight/.lock` (transient concurrency guard, was showing as an uncommitted change).
- This report + ledger update (queued items below).
- A consolidated **health dashboard** Cowork artifact (re-queries security/pipelines/FMV/offers/deploys/traction on open).
- **No risky DB migration was needed** — the offer RPC is correct, security is clean, and no broken view/RPC was found. (Deliberately did not manufacture DB changes.)

## 8. Handoff (code — Claude Code owns)

`docs/handoff-2026-05-31-audit-followups.md`: (1) replace the `/api/best-offers` mock with real `badge_editions` offers (or drop the fake column); (2) broaden edition-offer coverage via an all-editions `highestOffer` sweep; (3) onboarding funnel-leak repoint; (4) mobile overflow fixes (entity heroes + insights-tool tables); (5) moment-page mojibake + brand bare-literal + missing-asset polish; (6) optional smoke-suite cron-rush hardening (folds ledger Q5 + inbox P3).

## 9. The 16 uncommitted working-tree files

All **documentation** (handoffs, ledger, inbox, ops setup, team-hub feature docs) written by the autonomous monitor / nightly pass / recent sessions that couldn't commit (Cowork has no git creds; the scheduled sandbox's git is lock-blocked — ledger Q7). Safe to commit **except `docs/overnight/.lock`** (now gitignored). Durable fix = give the scheduled runner its own clone/native checkout (ledger Q7) so it commits its own docs. See chat for exact commands.

## 10. Recommendations (priority order)

1. Ship handoff items 1 (fake offers) + 3 (funnel leak) first — both are live trust/activation issues, both small.
2. Then 4 (mobile entity/insights overflow) — RPC's growth surfaces are public + SEO-indexed; mobile is where collectors land.
3. Broaden offer coverage (item 2) — turns "highest offer" from ~13% of TS editions into near-complete, the real substance of the offers ask.
4. Polish (item 5) + smoke hardening (item 6) + Flowty/`offers`/`marketplace_offers` teardown when convenient.
