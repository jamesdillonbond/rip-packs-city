# 2026-09-03 (evening PT) — Full health check + new-user walk + mobile audit · Cowork (desktop VM)

**Ask (Trevor):** "use the deep audit and QA skills to do a health check and audit across the entire project — tools, database, site, onboarding, to-do list, known problems, skills, scheduled tasks, artifacts, pipelines, operations and procedures … test the new user flow for core functionality and the most popular features … look for operational improvements … address any issues you find … better ways to optimize for mobile."

> ⚠ Scope line: this session pushed normally (persisted device-flow cred, fresh `$HOME/rpcwork` clone). A Claude Code session was shipping concurrently on Trevor's box (`d6c7b35 → 24924f3 → fd66faa` during the pass); the ledger was spliced into the freshly-fetched upstream and rebased.

## Verdict

**GREEN.** Security invariants clean, pg_cron 4,000 runs / 0 failures in 24 h, no stuck queries, vacuum keeping up, sitemap 33,591, home canonical + `og:url` present, both Pack Sniper feed legs healthy, the new-user flow passes end-to-end. Two real defects found, one fixed (DB), one filed (edge-fn code); ~12 smaller fixes shipped in one commit; the rest is written down below with evidence.

## What shipped

| what | where | revert |
|---|---|---|
| **Top Movers published STALE re-pricings as market moves** — every one of the founder's five "BIGGEST GAINERS" (+141% … +2,892%) was a STALE-confidence price with 0 sales in the window. A mover now needs a sales-backed current price AND ≥ 1 sale inside the window. 3,110 / 8,596 owned editions still qualify on the control wallet; cost not worse (68K buffers / 198 ms). | prod DB `20260904041433` + `20260904041544` (files in `supabase/migrations/`) | swapped-literal DO block in each file |
| **Watchlist alerted on a pipeline 10 min after it was added; thresholds > 24 h were silently 24 h.** Both arms now honour `created_at` (grace = the row's own threshold) and the lateral window is `GREATEST(24h, threshold)`. | prod DB `20260904041635` | swapped-literal DO blocks in the file |
| Anonymous "Watch this edition" → "Could not save the alert." (the proxy 307s to `/login`, fetch follows, client sees 405, never the 401 it waited for) → now "Sign in to set an alert →" | `components/alerts/WatchEditionButton.tsx` | `git revert` |
| `/api/badge-taxonomy` POST public (static taxonomy read; anon sniper fired it 7×/load → 405, no badge art signed-out); `/api/profile/me` GET public (route answers `{user:null}` by design; the proxy redirected first so 8 client components downloaded the login HTML per anon load) | `proxy.ts` + `proxy-is-public-path` rows | `git revert` |
| Mobile: body reserves the 60 px bottom nav (footer disclaimer was cut mid-sentence on 5 pages); SIGN IN no longer wraps; header handle 7 → 9 px | `MobileNav.tsx`, `SignOutButton.tsx`, `GlobalSiteHeader.tsx` | `git revert` |
| `/insights/top-sales` Candy art on `arweave.net` was CSP-blocked (blank cards) → routed through the same-origin avatar proxy (the CSP↔allowlist disjointness test correctly refused a CSP widening) | `TopSalesBoardClient.tsx` | `git revert` |
| Collection Breakdown header said "0 moments" while loading → "—"; share card rendered "1414 **SUnknown**" → "No series", sorted last | `CollectionBreakdownCard.tsx`, `lib/share-card-view.ts` | `git revert` |
| Pack-dist `generateMetadata` dropped `ok` from the corrected-EV read and fell back to the raw `gross_ev` the comment forbids | `pack/dist/[distId]/page.tsx` | `git revert` |
| Ops/docs: `e2e-smoke` cron `:41` → `:51` (collided with ops-monitor 06:41); CLAUDE.md "Needs TREVOR" drops #27 (resolved 09-02); `apis-and-cadence.md` stamps `public-api.nbatopshot.com` decommissioned | `.github/workflows/e2e-smoke.yml`, `CLAUDE.md`, `docs/reference/apis-and-cadence.md` | `git revert` |

Tests: every change carries its test in the same commit; `tsc` clean; targeted vitest (WatchEditionButton, share-card-view, CollectionBreakdownCard, proxy ×4, MobileNav, SignOutButton, GlobalSiteHeader, TopSalesBoardClient ×2, avatar-proxy-hosts, migration ×3, and the metadata/ratchet/worker set — 63 files / 916) all green; eslint on touched files 16 → 16 pre-existing. CI is the full gate.

## The new-user walk (what a collector sees, in order)

1. **Front door** `/` → paste `jamesdillonbond` → **~14 s** "ANALYZING…" → `/share/0xbd94…` card: $98,325.51, 19,403 moments, per-collection cards, top moments, series bars. Clean console. *(Slow, but honest and complete. The 14 s is the wallet warm; consider a progress line.)*
2. **Sign up** `/login` → magic link (Resend, branded `type=signup`) → `/api/auth/callback` → `/dashboard` with the 6-step tour. Step 4 (trophy case) has no anchor for a wallet-less account and renders centered — fine.
3. **Add wallet** → saved; **stats read 0 / $0 / 0 collections for ~30 s** while `aggregate_saved_wallet_stats` runs (8.8 s mean on this whale), with no "calculating" hint, then $47,641 + $52,005 stale. *(Open: the not-yet-read state renders as zero — the class Trevor cares about. Filed below.)*
4. **Claim handle** → `/profile/edit` → "Saved at … — View public profile →". Public profile renders; ANALYZE link resolves to the Top Shot name (31eb3a9 held). **Top Movers was the false claim** (fixed above).
5. **Pin a trophy** → picker (96 highest-value, filters, search) → pinned → `/profile/qa0904/trophy-case` renders, `index,follow`, self-canonical, OG `image/png`. Trophy-case share copy correct.
6. One dashboard reload returned **`/api/profile/hero-moment` 503** (DB 57014) and the Hero Moment card silently vanished — honest, but invisible.

## Filed, not shipped (evidence in the ledger entry of the same date)

- 🚨 **`allday-pack-opens-backfill`** — no `mode=backfill` invocation has reached the edge since **02:16Z** (pg_cron says `succeeded`; `net._http_response` shows each tick timing out at pg_net's 90 s wall; before that it sat on spork range `83301079–83301328` `status 0` for 14 ticks). Trevor gets the `[RPC alert]` email every ~6 h. Needs a poison-range rule + AbortSignal in `supabase/functions/ingest-allday-pack-opens` (spork constants → CLI deploy). And: AllDay is sunset — is the deep-history backfill worth keeping?
- 🟠 **Front door ($98,325) vs dashboard ($47,641 + stale) disagree 2×** at the activation moment — `/share` sums raw `wmc.fmv_usd`; the profile shows total − stale (the 09-02 decision). Product call; measure the `editions → edition_fmv_current` join cost on the 300 s-cached route first.
- 🟠 **Dashboard stats render 0 / $0 for ~30 s after a wallet is added** — needs a "calculating" third state on `PortfolioStats` (the `TopMoversCard` e8c3e22 shape).
- 🟠 **Pack-detail reads still exceed the 5 s wall** (`pack_lifecycle` 37 hits / 31 users in 48 h; `pack_realized_ev` 14) and `hero-moment` 57014 on the whale — the 08-30 index's exit criterion was never read back; use `ops_pgss_delta` per queryid.
- 🟡 Mobile leftovers: concierge FAB over the right column at y ≈ 716–768; `/trophy-case/<u>` → `/login` (public route is `/profile/<u>/trophy-case`; nothing links the short form); 9 px stat captions; `/login` legal links 10 px / 32×10; `Switch to light mode` 30×30; home hero starts at y ≈ 270. Harness: `$HOME/mobile-audit.mjs` (VM) — screenshots in `_to_delete/mobile-qa-2026-09-04/`.
- 🟡 `/api/og/insights%5C` → 500 (bots with an encoded backslash); `/api/rewards/track` 401 on anon `/insights/squeeze`.
- 🟡 Security advisor: 4 functions with mutable `search_path` (3 are the concurrent session's live work — leave to the owner); 269 unused indexes (retired trade/cart/offers surfaces); `classify-acquisitions` v39 (`verify_jwt=true`) is the deprecated May-11 function still deployed.
- 🟡 Schedule minute overlaps GHA↔Vercel (`refresh-insights-cache` = `topshot-sales-history-backfill` at `7,22,37,52`; `warm` = ops-monitor at `13,43`; several at :40 06Z) — tolerated so far; flagging only.

## Still Trevor's (structural, unchanged)

#22 defeated credential purge · #58 `OPENSEA_API_KEY` · alerting secrets · the two product calls above.

## Test account

`tdillonbond+qa0904@gmail.com` / handle `qa0904` — **deleted at close** (19-table sweep, one transaction, same reason as 09-03: an indexable public profile of an invented collector on the founder's wallet).
