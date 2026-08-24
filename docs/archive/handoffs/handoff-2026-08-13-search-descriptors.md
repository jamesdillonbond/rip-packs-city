# Handoff — catalog search, moment descriptors, and what's left

Claude Code (web session), 2026-08-11 → 2026-08-13 PT. Everything below is
**shipped to `main` and verified live** unless a section says otherwise.
Give this to Claude Code in the terminal, or to Cowork.

---

## 1. What shipped (all live, all ledgered with revert paths)

| # | Thing | Where |
|---|---|---|
| 1 | **Follow button** — the follows backend had existed since Phase 4 with ZERO callers | `components/profile/FollowButton.tsx`, `/api/profile/follows?username=` probe |
| 2 | **Global catalog search** — the site's first | `rpc_search_catalog`, `/api/search`, `components/search/GlobalSearch.tsx` |
| 3 | **Long-horizon price charts** from actual sale prints | `get_edition_sale_history`, `/api/entity/edition?part=sale-history`, `FmvHistoryChart` |
| 4 | **Moment descriptors** — `editions.description` + narrative search | `lib/topshot/play-description.ts`, `edition_description_coverage`, probe route |

**The headline result:** `lillard game winner` now returns *"Damian Lillard — For
the Win"* first, in 23ms. 76 Top Shot moments describe a game-winner; none were
reachable before.

---

## 2. Do these first (ordered, each is a one-liner)

### 2a. Re-run the catalog backfill to grow description coverage

Coverage is **44.6%** (5,885 / 13,197 canonical Top Shot editions). Each run
walks all sets but upserts a slice, so coverage climbs per run.

```bash
curl -s -X POST "https://www.rippackscity.com/api/admin/backfill-topshot-catalog" \
  -H "Authorization: Bearer $RPC_ADMIN_TOKEN" -o backfill.json -w "http_status=%{http_code}\n"
node -e "const d=require('./backfill.json');console.log(d.editions_upserted??d.extra?.editions_upserted, d.gql_calls??d.extra?.gql_calls, d.sets_processed??d.extra?.sets_processed)"
```

⚠ **Read `editions_upserted`, never the HTTP status.** This route returns
`ok: true` while writing nothing when its GraphQL query is invalid. **If
`gql_calls` EXACTLY equals `sets_processed`, it is broken** — that means one
call per set, i.e. every call died on its first page. Healthy looks like
`327 > 258`. Coverage then re-measures itself; nothing is hardcoded.

### 2b. Decide the AllDay 403 (blocks prose for collection #2)

Filed: `docs/overnight/inbox/2026-08-12T0428Z-allday-graphql-403-waf-block.md`.

AllDay GraphQL returns **403 with an HTML `<title>block</title>` WAF page**
through `ALLDAY_PROXY_URL`, with production-identical headers, while the Top
Shot arm on the *same request* succeeds — so it is not auth, not the secret, not
lambda egress. Both control fields fail, so the probe correctly refuses to draw
conclusions.

**Likely fix (unverified, needs your call):** `ALLDAY_PROXY_URL` probably needs
to point at the worker's `/allday-consumer` route rather than a bare host —
`ALLDAY_RELAY_QUERY` uses `allEditions`, which lives on the consumer endpoint.
Confirm against the worker's actual routes before changing. I did not touch the
env var: redirecting a production ingest on a guess is an operator decision.

**Corroborating but NOT proof:** `editions.last_updated_at` is NULL on all 6,190
AllDay rows. That column may simply never be written by that path. Do not file
"the AllDay ingest is broken" as fact until someone confirms the write path.

### 2c. Schedule the catalog backfill (needs a wrapper, not a `vercel.json` line)

⚠ **A naive Vercel cron entry will 401 every tick.** `verifyAdminRequest`
accepts **only** `RPC_ADMIN_TOKEN`; Vercel cron sends `CRON_SECRET`. This is the
exact trap that killed the old `pinnacle-sync` entry. The correct shape is a
`/api/cron/backfill-topshot-catalog` wrapper that checks `CRON_SECRET` /
`INGEST_SECRET_TOKEN` and calls the handler. Until then, description coverage
only grows when someone runs 2a by hand.

---

## 3. Landmines — read before touching any of this

1. **`editions` stores every Top Shot moment TWICE.** Integer `setID:playID`
   (canonical, 13,197) and a UUID pair (dupe residue, no thumbnail, **no
   sales**). Any new surface reading `editions` un-filtered returns every Top
   Shot result twice with ~doubled counts. Use the platform predicate:
   `external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'`.
2. **Top Shot `description` is on `Play`, NOT `PlayStats`.** Putting it in
   `stats { }` 422s the whole query and the backfill reports `ok: true` having
   written nothing. See §2a for the tell.
3. **The live `searchEditions` contract** — copy it from
   `app/api/admin/backfill-topshot-catalog/route.ts`, do not improvise:
   `filters` is REQUIRED (`bySetIDs`, UUID-format ids only) + `searchInput
   .pagination`, and the response path is the double-`data` inline-fragment
   `searchSummary.data.data[]`. The flat `searchEditions { data { … } }` shape
   does not exist.
4. **Sibling stats fields return SENTINELS, not nulls** — `draftYear: 0`,
   `draftRound: "N/A"`, `quarter: "NA"`. `lib/topshot/play-description.ts`
   exports `isSentinel()` for this. `headline` exists but is just the player
   name — **not** the moment page's editorial title, whose source is unlocated.
5. **`fmv_snapshots` starts 2026-03-31; `sales` starts 2020-07-28.** No
   long-horizon view can come from FMV. The 1Y/ALL chart chips read sale prints
   and the two series are deliberately never merged (different quantities).
6. **The sandbox cannot reach the collectible upstreams at all** (`status=000`)
   and holds no secrets. GraphQL discovery must run as a prod route.
7. **Never hardcode the description-coverage percentage.** The backfill moves it
   every run. `/api/search` reads `edition_description_coverage` live.

---

## 4. Still unbuilt — Trevor's ideas, with honest status

| Idea | Status |
|---|---|
| Search / encyclopedia | **DONE**, coverage-disclosed |
| Moment descriptions in DB | **DONE** for Top Shot (44.6%); AllDay blocked (§2b) |
| Charts (week/month/year/all) | **DONE** — 30d/90d FMV, 1Y/ALL sale prints |
| Community feeds / friend lists | **PARTIAL** — follow button shipped; feed lights up as follows accrue |
| **User tags / nicknames** | **NOT BUILT.** Recommendation: build it as *your* curation tool, not crowd-sourced — with 21 users there is no crowd. A `moment_tags` table + write API turns "Dame's series-clinching 37-footer" into a searchable entity Top Shot itself cannot answer. Feeds naturally into `rpc_search_catalog`'s edition arm alongside `description`. |
| **Multiple trophy cases + AI-built** | **NOT BUILT.** `trophy_moments` is keyed `(user_id, slot)` with a hard 6-slot cap enforced in 3 places — one unnamed case per user. Needs a `trophy_cases` table + `case_id` migration, plus a net-new concierge write tool (none of the 29 tools writes to `trophy_moments`). ⚠ Sobering: `trophy_moments` holds **16 rows total**. Nobody fills the one case that exists — worth understanding why before multiplying it. |
| **Slabs upgrade (CollectorFlex)** | **NOT BUILT** — deliberately. `TrophySlab.tsx` is already 835 lines with per-tier holo, tier glow, real badge art, gold 1-of-1 treatment, plus a separate satori/pdf-lib print path. I need you to point at what specifically reads worse — depth/lighting? frame? typography? — or this burns time on the wrong axis. |

**Two exposure decisions I deliberately left to you:**
- **No collector directory**, so following requires already knowing a username.
  A public `/collectors` index is a new public surface.
- **`GlobalSiteHeader` is only rendered by the `(collections)` layout**, so the
  search bar is absent on `/dashboard`, `/insights`, `/analytics` and `/`.
  `/insights` deliberately has no global header (lean public SEO surface);
  adding nav/logo/pro-badge there is a design change, not a bug fix.

---

## 5. Informational — measured, not acted on

- **36% of Top Shot and 60% of AllDay priced sales in the last 12 months are
  under $1.** The sale-print charts do not filter them: the roadmap records that
  removing the $0.50 dust floor was a deliberate accuracy decision, and
  re-imposing one inside a chart would override a pricing call. A thin month can
  therefore render a $0.40 median — the tooltip shows the sale count, so it reads
  honestly. Your call whether charts should treat dust differently from FMV.

---

## 6. Verification state at handoff

- Primary gate **1150 files / 10,975 tests** green; component gate **185 /
  1,561** green; `tsc --noEmit` clean; working tree clean.
- `check_public_security_invariants()` **0**, `check_anon_write_surface()` **0**.
- `rpc_search_catalog` and `edition_description_coverage` are **service_role
  only** (anon/authenticated verified false).
- `/api/search` confirmed live anonymously with the coverage note present.
- All prod migrations from this session have committed files (parity clean).
  ⚠ The final `rpc_search_catalog` + coverage-view DDL was applied via
  `execute_sql`, so prod carries **no migration row** for it; the committed file
  `20260813150000_audit_20260813_editions_description_search.sql` documents both
  deltas verbatim and records the live md5 `ccb0d012f48dd09ed2e034d299d4be9b`.
