# Rip Packs City — full-platform health check & audit (2026-06-03)

Cross-surface sweep at Trevor's request: threads/audits/roadmaps/ledger, database, cron, GitHub Actions, Vercel, Sentry, scheduled tasks, Cowork artifacts, the live website, skills — security + CX + onboarding + mobile + edition-offer wiring + brand standards + cleanup. Read-only except for reversible Sentry housekeeping (12 stale issues resolved). All code fixes are packaged for Claude Code in `docs/handoff-2026-06-03-audit-followups.md`.

Pass run from Cowork (DB-migration / edge-fn / artifact / Sentry capable; **no git push** — route/.tsx fixes go to the handoff). Verified live against prod commit `f3011d9` and the Supabase DB at ~2026-06-04 02:30Z.

---

## Headline

**The platform is healthy and the one explicit build ask is already satisfied.** The highest edition offer *is* displayed on moment pages — verified live (Cooper Flagg #20/35, edition 243:8274 → "Best offer $5,500 · today"). Security is genuinely 0/0/0, 20/20 Vercel deploys are READY, `detect_stalled_pipelines()` is empty, FMV writers are fresh, and all three historical fabricated-data landmines stay fixed. The findings below are polish and cleanup, not breakage — almost all are small code changes for the handoff. The one thing shipped this pass was Sentry hygiene (12 stale smoke-test issues resolved).

---

## Health snapshot (live, ~2026-06-04 02:30Z)

| Surface | State | Notes |
|---|---|---|
| Security (base tables) | **0 / 0 / 0** | 0 RLS-off base tables, 0 anon/auth write grants on RLS-off base tables, 0 anon-readable definer views. (My first broad query showed 979/11/23 — all artifacts: it counted RLS-*on* tables and missed the `security_invoker=true` normalization. Corrected queries = clean.) |
| Anon-executable SECDEF fns | 23, all intentional | Enumerated; all are public-page / concierge / MCP / insights read RPCs or the deliberate `submit_allow_list_request` beta-form writer. None write sensitive data. |
| Pipelines | `detect_stalled_pipelines()` = **[]** | Recent `ok=false` are the known transient classes only (compute-topshot-pack-ev GQL "Signal timed out", cron-rush connection-pool timeouts, check-alerts `get_pipeline_alerts` statement-timeout). No logic faults, none deploy-attributable. |
| FMV | Fresh ~1–2 min | TS HIGH+MED 932 / AllDay 273. Primary writer (fmv-recalc) healthy. |
| Edition offers | Fresh (02:20Z) | `edition_offers` = 8,863 TS editions, 5,565 with a positive offer. Top Shot only (by source availability). |
| Vercel | **20/20 READY, 0 ERROR** | Prod HEAD `f3011d9` (FMV mis-key sweep F2/F3/F4/F5 — newer than the morning baseline `d8cc6c2`). |
| Sentry | Resolved **12** stale issues | Cleared the 12 dead "public page returns 200" / profile smoke issues (quiet 26–27d). Remaining unresolved are mostly recent (3–14d) transient smoke cry-wolf whose targets I directly re-verified clean (RLS 0 holes, destructive SECDEF not anon-exec, `detect_stalled`=[]); plus PIN1 (NEXTJS-15, active-known) and 2 real-but-stale pack-dist render errors (NEXTJS-18/17, last seen 8d). |
| DB size | 5,999 MB | Stable. |
| Scheduled tasks | 7, all enabled, on-cadence | nightly pass, daytime monitor, 2× weekly health, candy audits (Jun 22 + Jul 8), monthly memory consolidation. |
| Cowork artifacts | 12 present/healthy | rtr-pack-finder added 06-03; health dashboards current. |

---

## 1. Edition offers — the priority ask (VERIFIED WORKING)

**Status: already correct on both named surfaces; one secondary-surface gap.**

- `get_edition_high_offer(p_edition_id uuid)` returns `(highest_offer, low_ask, updated_at)`, prefers the `edition_offers` cache then `badge_editions`. Collection-agnostic and correct.
- **Moment page** `app/moment/[id]/page.tsx`: fetches it (L200–211), invokes per-edition (L445), renders a gated "Best offer" stat (L708–720). **Confirmed live** — `/moment/4999f947…` (Cooper Flagg #20/35) shows "Best offer $5,500 · today" next to FMV/Floor/WAP/Top Shot ask.
- **Edition page** `app/(collections)/[collection]/edition/[slug]/page.tsx`: same fetch + render (L213–219, L256, L419–425); prior pass confirmed `/nba-top-shot/edition/8:133` → BEST OFFER $5,000.
- **Gap (P2/P3, → handoff item 1):** the shared `components/MomentDetailModal.tsx` (the hover/click modal on the collection grid + sniper) has **no offer prop** — so a deal card there shows FMV/list price but not the best offer. The collection grid already holds the data (`offerMap` from the `edition_offers`-backed `/api/best-offers`), so the fix is purely passing a `bestOffer` prop. No DB or RPC change needed.
- **AllDay shows no offer = data gap, not a defect.** `edition_offers` is 100% Top Shot because no AllDay offer/bid source exists (the AllDay marketplace GQL exposes none — confirmed by exhaustive probe in the 06-01 H4 work). `get_edition_high_offer` is collection-agnostic and would surface AllDay offers the instant a source lands. Correctly hidden today (no permanent em-dash).
- Data-quality note (not a display bug): some offers exceed FMV/ask (Cooper Flagg offer $5,500 vs ask $4,250). That's a real cache value, surfaced honestly; it's the "offer ≥ ask" class the `/insights/offer-spread` board frames as not-guaranteed-arbitrage.

---

## 2. Security & data integrity (CLEAN)

- 0 RLS-off public base tables; RLS on all base tables; 0 anon/authenticated write grants on any RLS-off base table; 0 anon-readable SECURITY DEFINER views.
- 23 anon-executable SECDEF functions, all intentional: public moment/edition/wallet/pack/insights read RPCs (`get_moment_detail`, `get_wallet_pack_summary`, `get_top_deals`, `get_wallet_tc_report`, `get_pack_for_simulator`, …), the MCP/concierge RPCs (`mcp_get_fmv`, `mcp_compute_pack_ev`, …), two trigger functions (harmless to hold EXECUTE), and `submit_allow_list_request` (the early-access form — anon write by design, IP-hash + length-capped). None expose PII beyond public on-chain data.
- Fabricated-data landmines all confirmed fixed and not regressed: `/api/best-offers` (real `edition_offers`), `lib/trade-escrow/fcl-submit.ts` (`ensureLive()` throws + routes 503), home STATS block (real numbers — DB confirms 304,497 sales vs the "280K+" floor shown).

---

## 3. CX & new-user onboarding (CLEAN funnel; 3 small CX items)

Funnel verified clean: every primary CTA on the logged-out marketing home routes to an anon-reachable destination (wallet-paste → `/share`, collection tiles → `/<collection>/overview`, Insights → `/insights`, Fast Break → `/nba/fast-break`, pricing → `/early-access`). No `/login` bounce at the activation moment. `proxy.ts` public rules cross-checked.

Items (→ handoff):
- **P2 — concierge "+ Cart" silent dead-end.** `components/SupportChatConnected.tsx:99` passes `onAddToCart` into the live concierge, so deal cards render a "+ Cart" button — but Cart is shelved and sniper-feed deals map to `dapper_only`, so the click silently no-ops (or, when eligible, writes a misleading "Added to your cart" message for a cart that can't check out). Fix = drop the `onAddToCart` prop so the button doesn't render. (handoff item 2)
- **P3 — `/signup` is a public proxy rule with no page.** `proxy.ts:149` whitelists `/signup`, but `app/signup/` doesn't exist; unlinked, so it 404s only if typed directly. Drop the rule (or add the page). (handoff item 4)
- **P3 — CSV export uses a native `alert()` gated to a hardcoded wallet.** `app/(collections)/[collection]/collection/page.tsx:1891` — off-brand and premature (no paywall until 50+ WAU). Low priority. (handoff item 6)

Empty states (`/share`, dashboard) and concierge error copy reviewed — correct, on-brand, honest.

---

## 4. Mobile & brand standards

**Mobile: responsive CSS confirmed; one minor gap.** Viewport meta present; the moment hero (`.rpc-moment-hero`) collapses to one column < 768px (confirmed directly in the served markup), `.rpc-entity-hero` collapses < 640px, wide tables wrap in `.rpc-scroll-x`, the footer stacks < 640px. Prior passes live-verified mobile; this pass re-confirmed the moment page renders cleanly. (Note: the browser `resize_window` tool didn't actually constrain the viewport this session — screenshots came back at desktop width — so a fresh 390px device render wasn't capturable, but the media queries are present in the markup.)
- **P3 — RTR LivePickCard** `components/rtr/RTRClient.tsx:226` uses `minWidth: 200` inside a tight flex row that could overflow ~380px. (handoff item 5)

**Brand: a long tail of hardcoded literals, mostly low-value.** ~hundreds of `#E03A2F` / `'Barlow Condensed'` / `'Share Tech Mono'` literals exist outside `rpc-tokens.css`. The majority are **acceptable contexts** and not real violations: OG/`opengraph-image` routes (edge/satori can't read CSS vars), email HTML bodies, `app/global-error.tsx` (renders without app CSS), the recharts `stroke` SVG attr (can't resolve a CSS var — documented exception), `lib/collections.ts` accent **data**, and the `var(--rpc-red, #E03A2F)` fallback pattern (prefers the token). The genuinely-fixable set is the plain component style-props that hardcode the color with no fallback (e.g. `app/terms`, `app/privacy`, `app/early-access`, `app/profile/[username]`, `components/auth/SignOutButton`, `components/OnboardingModal`, overview/sniper accent fallbacks). This is a **low-value mechanical cleanup, not urgent** — the literal renders the correct color; there's no user-visible defect. Recommend a scoped token pass only when those files are touched anyway. (handoff item 7, optional)

---

## 5. Cleanup / outdated

- **Dead code (→ handoff):** `lib/pro/gate.tsx` — confirmed zero importers (only docs reference it); `git rm`. `app/api/moment-offers/route.ts` — zero callers, and broken-by-design (direct Cloudflare-blocked egress + dead Flowty); delete. (handoff item 3)
- **Phase-D shims:** 11 re-export-only modules under `lib/` (`flow.ts`, `topshot.ts`, `allday.ts`, …) — intentionally kept for back-compat; inventoried, no action.
- **Shelved features correctly guarded:** Cart (dormant, unimported), Trade Hub (`RPC_TRADE_ESCROW_ADDRESS` gate + 503 routes + `notFound()`), Breaks (token-gated, schema unapplied). No action.
- **Flowty:** frozen by the 2026-05-24/06-01 decision (~45 MB inert; backs live admin analytics surfaces). No action.
- **Doc drift (→ handoff, docs):** CLAUDE.md known-issue #15 (fixtures) is resolved but still open in the doc; rookies view name `topshot_rookies_board` lingers in historical docs (live view is `topshot_2025_rookie_index`). `docs/operations/cron-schedule.md` is current (lists offers-sweep + evm — this corrects an older ledger "missing" note). Cosmetic.

---

## 6. Infra sweep

- **Vercel:** 20/20 recent deploys READY, 0 ERROR. Current prod `f3011d9`.
- **Sentry:** resolved the 12 dead smoke-test issues (26–27d quiet). The remaining unresolved set, examined: (a) recent transient smoke cry-wolf (NEXTJS-1C RLS / 1D destructive-SECDEF / 1E stalled-indexers / -A / -B / -4 / -12 / -14 — the Q5/A6 cron-rush class) — I directly re-verified each underlying target is clean (0 RLS holes, no destructive SECDEF anon-executable, `detect_stalled`=[]), so these are false alarms, not regressions; (b) 2 **real-but-stale** pack-dist Server-Component render errors (NEXTJS-18 "tierChip called from server" + NEXTJS-17, on `/[collection]/pack/dist/[distId]`, last seen ~8d — already CLAUDE.md known-issue #17); (c) 1 stale analytics TypeError (NEXTJS-1A, 14d); (d) PIN1 (NEXTJS-15) active-known. Action for 18/17: verify whether the 06-03 pack-page changes (`64e3f4a7`) already fixed them — if quiet 8d+, resolve; else fix the `tierChip` client/server boundary (the known RSC client-function-call-crash class).
- **cron / pipelines:** healthy; only the known transient cron-rush + pack-EV GQL-timeout classes. `compute-topshot-pack-ev` is failing ~hourly on `GetPackEditions` "Signal timed out" — known pack-EV GQL fragility, pack-EV logic is off-limits to autonomous change; flagged for operator/CC if it persists.
- **GitHub Actions:** CI gates `tsc` + the cadence-lint blocking gate + smoke; the latest prod deploy reaching READY implies the build/typecheck passed on `main`.
- **Scheduled tasks & artifacts:** all healthy (see snapshot).

---

## 7. What shipped this pass

- **Sentry housekeeping (reversible):** resolved 12 stale smoke-test issues (NEXTJS-C, -Y, -X, -V, -K, -M, -F, -Q, -G, -10, -W, -T), each quiet 26–27 days; each auto-reopens on regression. (Remaining unresolved are recent transient smoke cry-wolf + 2 known-stale pack-dist errors + PIN1 — see §6.)
- **No DB migration needed** — the offer RPC and security posture are both already correct. Honest outcome: nothing in the DB layer required a fix.

---

## 8. Prioritized follow-ups (all code → `docs/handoff-2026-06-03-audit-followups.md`)

1. **P2** — concierge "+ Cart" silent dead-end: drop `onAddToC