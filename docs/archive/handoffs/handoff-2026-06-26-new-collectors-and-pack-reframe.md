# Handoff 2026-06-26 — New Collectors insights surface + buyer-backfill scope + pack-reality reframe

Origin: Cowork competitive-recon pass on **vaultopolis.com** (analytics + packs + liquidity) and **stateofmint.com/tools/stats/new-users** (cohort/acquisition/retention intelligence). State of Mint's New-Users tool is the genuine missing surface for RPC and is squarely the "intelligence-first" lane. This handoff ships it.

> Claude Code's direct file inspection wins over this doc (and over `project_knowledge_search`) on any disagreement — adapt to the actual file shape. File paths below were verified to exist via the live repo at handoff time; line numbers are approximate.

---

## Context — what's already LIVE (shipped by Cowork via Supabase MCP)

The entire **DB + refresh + cron layer is already shipped and verified.** This handoff is ONLY the route/.tsx/cron-doc that Cowork can't push to git, plus two scoped projects.

Migrations applied (project `bxcqstmqfzmuolpuynti`):

| Migration | What |
|---|---|
| `audit_20260626_new_collectors_buyer_spine_mv` | `mv_ts_buyer_first_buy` — per-buyer first-marketplace-buy spine. **service_role only** (holds wallet addresses); anon REVOKED. Index on `first_buy_at`. |
| `audit_20260626_new_collectors_summary_mv` | `mv_insights_new_collectors_summary` — per-window acquisition + spend headline. anon SELECT. |
| `audit_20260626_new_collectors_spend_mv` | `mv_insights_new_collectors_spend` — first-buy price histogram per window. anon SELECT. |
| `audit_20260626_new_collectors_gateway_mv` | `mv_insights_new_collectors_gateway` — gateway sets + players (top 10 each, 30d/90d). anon SELECT. |
| `audit_20260626_new_collectors_cohorts_mv` | `mv_insights_new_collectors_cohorts` — monthly cohort behavior (size, repeat 30/60/90, LTV, whales, days-to-10th). anon SELECT. |
| `audit_20260626_refresh_new_collectors_fn` (+ `_fix_generated_col`) | `refresh_insights_new_collectors()` — SECDEF, service_role only, self-logs `pipeline_runs` as `refresh-new-collectors`. Refreshes spine then the 4 aggregates. |

**pg_cron** job `rpc-refresh-new-collectors` (`45 9 * * *` UTC) calls the refresh fn daily. First manual refresh ran ok=true, 12,359 buyers, 2.5s.

Verified at ship: `check_public_security_invariants()` = 0; `check_secdef_anon_execute_violations()` = `[]`; anon CAN read the 4 aggregate MVs; anon CANNOT read the spine MV (addresses hidden).

**The honesty constraint (must surface on the page).** RPC's buyer coverage on TS sales is **0% for 2020-21, 32–56% for 2022-25, ~74% for 2026** (and climbing as the buyer backfill runs). Consequence:
- **Accurate today (~92% of active buyers captured in recent windows):** active buyers, returning buyers, market $, spend distribution, gateway sets/players.
- **Inflated today (~3x):** raw "new buyers" count — partial history mislabels returning collectors as new. `new_debiased` removes the ~26% provably-not-new (seen selling before their first observed buy). True fix = the deep buyer backfill (Item 2). The board MUST carry a one-line coverage caveat and lead with the accurate metrics.

Live numbers at ship (for sanity-checking the page):

```
window  new_first_seen  new_debiased  active  returning  market_usd  median_first_buy
7d      51              42            1210    1159       170,188     $1.70
30d     267             198           2337    2070       614,815     $1.80
90d     1023            724           3755    2732       2,217,948   $1.90
```
Gateway players 90d: Wembanyama 95, LeBron 57, Jokić 42, Brunson 38, Caitlin Clark 24, SGA 24, Stephon Castle 22, Luka 19.
Gateway sets 90d: Base Set S8 161, Top Shot This: Playoffs S8 105, Top Shot This S8 52, Base Set S6 39, WNBA Base Set S8 35.

---

## Item 1 — `/insights/new-collectors` public surface  (PRIMARY)

Clone the established insights pattern. Closest templates: `app/insights/serial-premiums/` (route + layout + OG) for the plumbing, and a multi-panel page like `app/insights/cross-collection/page.tsx` for a multi-section stats layout. The proxy already lets `/api/public/*` and `/insights/*` through for anon.

### Data contract (read these MVs — all anon-granted)

`mv_insights_new_collectors_summary` (3 rows): `window_label`('7d'|'30d'|'90d'), `days`, `new_first_seen`, `new_debiased`, `new_prior_period`, `active_buyers`, `returning_buyers`, `market_usd`, `new_usd`, `median_first_buy`, `avg_first_buy`, `computed_at`.

`mv_insights_new_collectors_spend` (3 rows): `window_label`, `b_lt5`, `b_5_25`, `b_25_100`, `b_100_500`, `b_500plus`, `total_new`, `computed_at`.

`mv_insights_new_collectors_gateway` (40 rows): `window_label`('30d'|'90d'), `kind`('set'|'player'), `name`, `series`(set only), `buyers`, `rnk`(1–10), `computed_at`.

`mv_insights_new_collectors_cohorts` (48 rows, monthly desc): `cohort_month`(date), `cohort_size`, `repeat_30d_pct`, `repeat_60d_pct`, `repeat_90d_pct`, `ltv_median`, `ltv_avg`, `whales`, `median_days_to_10th`, `computed_at`.

### Files to create

**1a. `app/api/public/insights/new-collectors/route.ts`** — one fetch powers the whole page. Full file:

```ts
// app/api/public/insights/new-collectors/route.ts
//
// PUBLIC INSIGHTS — New Collectors. Acquisition funnel + cohort retention for
// NBA Top Shot, computed from buyer-resolved on-chain marketplace sales.
// Backs /insights/new-collectors. Under /api/public/* so proxy.ts lets anon through.
//
// Reads four anon-granted materialized views (refreshed daily by pg_cron
// rpc-refresh-new-collectors -> refresh_insights_new_collectors()).
//
// COVERAGE HONESTY: active/returning/market-$ and all composition (spend mix,
// gateway sets/players) are reliable for recent windows (~92% of active buyers
// captured). Raw new-buyer COUNT is inflated ~3x by partial historical buyer
// coverage; new_debiased strips wallets seen selling before their first observed
// buy. Self-corrects as the deep buyer backfill lands.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

export const revalidate = 0

export async function GET(_req: NextRequest) {
  const startedAt = Date.now()
  try {
    const [summary, spend, gateway, cohorts] = await Promise.all([
      supabase.from("mv_insights_new_collectors_summary").select("*"),
      supabase.from("mv_insights_new_collectors_spend").select("*"),
      supabase.from("mv_insights_new_collectors_gateway").select("*"),
      supabase.from("mv_insights_new_collectors_cohorts").select("*").order("cohort_month", { ascending: false }),
    ])
    const err = summary.error || spend.error || gateway.error || cohorts.error
    if (err) throw err

    // Shape gateway -> { "30d": { sets:[...], players:[...] }, "90d": {...} } ordered by rnk.
    const gw: Record<string, { sets: any[]; players: any[] }> = {}
    for (const row of gateway.data ?? []) {
      const w = (gw[row.window_label] ??= { sets: [], players: [] })
      ;(row.kind === "set" ? w.sets : w.players).push(row)
    }
    for (const w of Object.values(gw)) {
      w.sets.sort((a, b) => a.rnk - b.rnk)
      w.players.sort((a, b) => a.rnk - b.rnk)
    }

    const computedAt = summary.data?.[0]?.computed_at ?? null
    return NextResponse.json(
      {
        meta: {
          fetched_at: new Date().toISOString(),
          computed_at: computedAt,
          source: "mv_insights_new_collectors_*",
          elapsed_ms: Date.now() - startedAt,
          coverage_note:
            "Active/returning/market-$ and composition are reliable for recent windows (~92% of active buyers captured). New-buyer counts are a lower-confidence directional metric (partial historical buyer coverage); they self-correct as deep-history buyer resolution backfills.",
        },
        summary: summary.data ?? [],
        spend: spend.data ?? [],
        gateway: gw,
        cohorts: cohorts.data ?? [],
      },
      { headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=1800" } }
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/insights/new-collectors]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
```

> If PostgREST doesn't expose the MVs to `supabase.from()` in this project's schema cache (it should — they're in `public` with grants), fall back to a tiny SECDEF getter `get_new_collectors_board()` returning one `jsonb`. Try `.from()` first.

**1b. `app/insights/new-collectors/layout.tsx`** — clone `app/insights/serial-premiums/layout.tsx` exactly; change copy. Param-stripped self-canonical `${SITE_URL}/insights/new-collectors`, OG image `${SITE_URL}/api/og/insights/new-collectors`, WebApplication JSON-LD. Suggested:
- title: `New Collectors — Who's Entering Top Shot, and What They Buy First | Rip Packs City`
- description: `NBA Top Shot's acquisition funnel: new vs returning buyers, first-buy price, the sets and players new collectors pick first, and monthly cohort retention & LTV. Free. No signup.`

**1c. `app/insights/new-collectors/page.tsx`** — `"use client"`, brand tokens only (`var(--rpc-red)`, `var(--font-display)`, `var(--font-mono)` — never hardcode `#E03A2F`/`'Barlow Condensed'`), and the standard insights chrome (`MobileNav` + `SupportChatConnected`, same as serial-premiums/page.tsx). Fetch `/api/public/insights/new-collectors` once. Sections, top to bottom:

1. **Header + window toggle** (7D / 30D / 90D — drives which `summary`/`spend` row + which `gateway` window; cohorts always all-months).
2. **Acquisition** — cards: Active Buyers, New (show `new_debiased` as the headline number with `new_first_seen` as a muted "observed" secondary), Returning, New $ share (`new_usd`/`market_usd`). Small caption: "New-buyer counts are directional — see methodology." (Do NOT lead with the inflated `new_first_seen`.)
3. **Spend** — Median First Buy, Avg First Buy, + the first-buy price histogram (`b_lt5`…`b_500plus`).
4. **Gateway** — two ranked lists side by side: Gateway Sets (`name` + `S{series}` + `buyers`) and Gateway Players (`name` + `buyers`), for the selected window. Link each set/player into the existing entity hubs (`/nba-top-shot/set/<slug>`, `/nba-top-shot/player/<slug>`) using the repo's `slugifyName` so it roundtrips with `sitemap.ts` — this is the internal-linking equity the other boards already do.
5. **Cohorts** — monthly table: Month, Size, Repeat 30/60/90%, LTV (median), Whales, Median days-to-10th. Default to the last ~15 months (most recent first); offer a "show all" to 2022-04. Render an honest caption that cohort SIZE for older months undercounts (the visible ramp — e.g. early-2026 months read tiny) until the buyer backfill lands.
6. **Methodology footer** — "A new collector is a wallet's first observed marketplace buy. Buyer identity is resolved from on-chain sales; coverage is near-complete for recent windows and partial before 2026, so absolute new-buyer counts are a lower bound / directional and self-correct as historical buyer resolution backfills. Refreshed daily." + the `meta.computed_at` freshness chip.

Honest empty states (never a blank panel). No `?param` filter needs `min_*` floors here (no per-entity drill-down that could 0-out), but keep the param-stripped canonical from the layout.

**1d. `app/api/og/insights/new-collectors/route.tsx`** — clone `app/api/og/insights/serial-premiums/route.tsx`, change the title/subtitle text. 1200×630. (The 3 hardcoded brand hexes inside an OG `ImageResponse` are the universal Satori exception every insights OG route shares — fine.)

**1e. `app/sitemap.ts`** — add `'new-collectors'` to the insights slug array (the list mapped near line ~335-338 producing `/insights/${r}`). Keep it alphabetical-ish with the others; bump the "(19 routes)" comment to 20.

### QA before/after deploy (rpc-insights-qa)
- `npx tsc --noEmit` clean.
- After deploy READY: smoke all three — `/api/public/insights/new-collectors` returns 200 JSON with `summary`/`spend`/`gateway`/`cohorts`; `/insights/new-collectors` renders for anon; `/api/og/insights/new-collectors` returns 200 image.
- Backing views already `check_public_security_invariants()` = 0 (verified live).
- Add `new-collectors` to the `rpc-insights-health` artifact's surface list (Cowork can do this after deploy).

### Revert (Item 1 code)
`git revert <commit>` for the route/page/layout/OG/sitemap. The DB layer is independent (revert below).

---

## Item 2 — Deep-history buyer backfill  (PROJECT SCOPE — gated on Trevor's go, do NOT auto-start)

**Why.** This is the single lever that turns the New Collectors board from "directional" into census-accurate, and the only thing blocking RPC from reproducing State of Mint's full 2020→now cohort chart. Verified buyer coverage on TS sales:

```
2020  70,134 sales   0% buyer
2021  83,104         0%
2022  36,805        56%
2023  97,804        38%
2024  90,415        42%
2025 103,655        32%
2026 274,159        74%  (climbing)
```

**Mechanism.** Same machinery RPC already built for V1 Dapper sale decoding (`lib/dapper-v1-tx-decode.ts` — buyer = `<collection>.Deposit.to`, seller = `Withdraw.from`, price from `DapperUtilityCoin.TokensWithdrawn`). The gap is purely *reach*: the wired sporks only floor out ~2023 (mainnet19+). 2020-22 buyers need **mainnet1-18 spork access**, which `spork-proxy` does not currently front.

**Scope (discrete, inert-first):**
1. Extend `spork-proxy` (Cloudflare worker, own `SPORK_PROXY_SECRET`) to reach mainnet1-18 historical access nodes — confirm one 2021 TS `Deposit`/sale tx decodes end-to-end before anything else.
2. A backfill route (`/api/admin/backfill-topshot-buyers?mode=deep-history` or extend the existing historical buyer lane) that walks the ~153k null-buyer 2020-22 rows + the partial 2023-25 tail, decoding buyer/seller, env-gated (`TS_DEEP_BUYER_BACKFILL_ENABLED=1`), low-cadence cron, self-logging.
3. As coverage rises, the New Collectors board auto-sharpens (the MVs recompute nightly) — no board change needed.

**Effort / risk.** Real but bounded; it's reach-extension of proven decode logic, not new logic. Worker deploy is manual `wrangler` (not git). The 2020-21 sporks are the unknown (availability/rate-limits of those historical access nodes). Frame as its own focused pass; don't fold into Item 1.

---

## Item 3 — `/pack/dist` live "value still sealed vs pack price" reframe  (Vaultopolis-style, cheap win)

**File:** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` (verified exists).

**What Vaultopolis does that's worth taking** (NOT their custodial repack/liquidity business — just the analytics framing): an open pack shows a live **"Avg value still sealed ~$X · ▲42% above pack price"** meter plus **Top pulls still sealed** (best remaining moments with live FMV + serial), where "remaining" = drop pool minus what's already been opened.

**RPC already has every input** — this is a page-layer reframe, no new pipeline:
- Sealed-pool value = Σ over `pack_drop_pool` rows with `drop_weight > 0` of (latest FMV × normalized pull probability × slots) — the same weighting already in `compute_pack_ev_per_edition_weighted` / `pack_ev_latest`. You already compute Gross EV; reframe it as **"value still sealed"** and show it against the pack's retail/primary price as **"% above/below pack price"** (suppress on reward packs where `retail_price_usd = 0`, per the existing reward-pack handling).
- "Top pulls still sealed" = the top-FMV pullable editions (you already fetch a top-FMV hero set / "What's Inside"); just label them as the live chase pool and show serial/circulation.
- Optional depletion: `pack_rips` already bridges opened packs; the existing dist page already surfaces depletion from `pack_distributions.metadata` (v20+). Lean on that for "X of Y opened" rather than recomputing.

**Spec:** add a headline strip near the existing EV block — "Value still sealed: $X.XX/pack · ▲N% vs $Y pack price" with the same FMV-coverage caveat the page already shows below ~80% coverage. Keep it honest (it's an FMV-weighted expectation, not a guarantee). Everything else on the page stays.

**Revert:** `git revert <commit>` (single page file).

---

## Guardrails (every item)
- **Direct to `main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, switch to `main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Verify push: `git rev-list --count origin/main..HEAD` → expect 0.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** (higher → invisible ERROR deploy). None of these items need it.
- CRLF: full-file writes or `findIndex` on split lines; don't string-replace-patch.
- `npx tsc --noEmit` before deploy; confirm the Vercel deploy reaches READY; smoke per Item 1.

## Ledger / CLAUDE.md entry to append  (I did NOT edit the ledger from Cowork — mount-truncation hazard)

Append to `docs/overnight/ledger.md` Shipped + add a CLAUDE.md Recent-sessions line:

> **2026-06-26 (Cowork) — New Collectors insights surface (DB layer live).** Competitive recon (Vaultopolis, State of Mint new-users). Shipped 6 migrations + pg_cron `rpc-refresh-new-collectors` (`45 9 * * *`): spine `mv_ts_buyer_first_buy` (service_role only) + 4 anon aggregate MVs (`mv_insights_new_collectors_{summary,spend,gateway,cohorts}`) + SECDEF `refresh_insights_new_collectors()` (self-logs `refresh-new-collectors`). Security 0/[]; spine hidden from anon. Honesty: buyer coverage 0% 2020-21 / 32-56% 2022-25 / 74% 2026 → recent metrics census-grade, new-buyer count inflated ~3x (new_debiased strips ~26%). Page/route/OG/sitemap handed to CC (this doc). **Revert (DB):** `SELECT cron.unschedule('rpc-refresh-new-collectors'); DROP FUNCTION public.refresh_insights_new_collectors(); DROP MATERIALIZED VIEW public.mv_insights_new_collectors_summary, public.mv_insights_new_collectors_spend, public.mv_insights_new_collectors_gateway, public.mv_insights_new_collectors_cohorts, public.mv_ts_buyer_first_buy;`

## Expected end state
`new-collectors` route+page+layout+OG live on `main`, deploy READY, all three smoke 200 for anon, sitemap lists it, board renders the live numbers above with the coverage caveat. DB layer already live and self-refreshing daily.
