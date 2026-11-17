# Handoff — 2026-07-28 (round 2) · browser-QA follow-ups

## Context

Round 1 (`docs/handoff-2026-07-28-audit-followups.md`) is drained — thank you. This round comes from the **rendered browser pass** that round 1 couldn't do (Chrome was disconnected then; Trevor opened it afterwards). Verified against production at `36e08dac`.

**Already shipped by Cowork, needs nothing from you:**

- `audit_20260728_panini_squeeze_honest_coverage_column` — adds `serials_with_recorded_price` to `panini_squeeze_board`. **Purely additive**; `real_sales` is untouched and byte-identical, so all four existing readers keep working and nothing renders differently today. This is the EXPAND half of an expand/contract rename. **Item 6 below is the CONTRACT half — please finish it.**
- `audit_20260728_panini_squeeze_restore_security_invoker` — fixes a regression the migration above introduced. See the warning in item 6; it is the most useful thing in this document.

**Confirmed green in the browser, no action needed:** `/api/recent-sales` returns 15/15 populated player + set + FMV on all four collections that serve the panel, each with only its own marketplace; the rendered panel shows 15 priced rows with real `vs FMV` percentages (1 em-dash total, against ~45 this morning). Both launch gates hold under `credentials:'omit'` — board *and* public API 302 to `/login` while public controls pass.

---

## ⚠ 6. Finish the expand/contract rename on `panini_squeeze_board` — and read the gotcha first

**Files:** `app/api/public/insights/panini-squeeze/route.ts:7`, `app/insights/panini-squeeze/page.tsx:11`, `app/insights/panini-squeeze/PaniniSqueezeClient.tsx:18`, `__tests__/api-public-panini-squeeze.test.ts:47`

**THE GOTCHA, because it will bite you and it bit me:** `CREATE OR REPLACE VIEW` **does not preserve `reloptions`**. My migration replaced the view without restating them, which silently dropped `security_invoker=on` and left the view running with owner (`postgres`) privileges. `check_public_security_invariants()` immediately returned `(view_unexpected_definer, panini_squeeze_board)`. Blast radius was nil — SELECT grants survived as `postgres` + `service_role` only, and `anon` holds `REFERENCES` and never `SELECT`, so it was never anon-readable — but the declared posture was wrong for a few minutes and I only caught it because I ran the invariant check afterwards.

**Rule going forward:** any `CREATE OR REPLACE VIEW` in this project must either restate `WITH (security_invoker=on)` inline or be followed by `ALTER VIEW … SET (security_invoker = on)` in the *same* migration, and must end by reading `check_public_security_invariants()`. Currently verified clean: `reloptions = {security_invoker=on}`, 0 breaches, grants `postgres,service_role`.

**The contract half:** swap `real_sales` → `serials_with_recorded_price` in the two PostgREST select lists, the client type, and the test fixture. Then drop the dead column:

```sql
-- only after the four consumers above are deployed and green
CREATE OR REPLACE VIEW public.panini_squeeze_board AS … ; -- without real_sales
ALTER VIEW public.panini_squeeze_board SET (security_invoker = on);  -- ⚠ do not omit
SELECT count(*) FROM check_public_security_invariants();             -- expect 0
```

**Why the rename at all** (Trevor delegated the call, so this is my ruling): the column has always computed serial-level *price coverage*, not market activity — only 5,052 of 29,222 serials (17.3%) carry a `last_sale_usd` — while the adjacent `fmv_confidence` derives from `ms.txns`, the upstream marketplace transaction count. Two different quantities in neighbouring columns read as corroborating, which is why 840 editions currently advertise `HIGH` beside `0`. Renaming keeps a genuinely useful signal and stops it lying. **Do not "fix" it by re-sourcing from `ms.txns`** — that count is discarded at ingest today and isn't available to the view.

**The durable follow-up, worth doing separately:** persist `ms.txns` into `panini_fmv_snapshots` (e.g. a `sale_count` column) in `lib/chains/panini/ingest-normalize.ts`. Today `fmv_confidence` is unauditable — nothing stored anywhere explains why an edition is `HIGH`. Persisting it makes confidence explainable *and* finally gives the board an honest market-activity column. Related: `panini_fmv_snapshots.serial_fmv` is NULL on all 13,089 rows and has never been written.

**Revert:** the migration header carries the exact inverse.

---

## 7. Every collection tab route ships with zero headings — one component fixes ~30 pages

**File:** `components/collection-chrome.tsx`, lines 113–114 (inside `CollectionBanner`)

Measured against **server-rendered HTML** (`fetch` + regex on the raw response — what a crawler sees, not the hydrated DOM):

| page | h1 | h2 |
|---|---|---|
| `/` | 1 | 6 |
| `/insights` | 1 | 27 |
| `/insights/squeeze` | 1 | 1 |
| `/packs` | 1 | 0 |
| `/nba-top-shot/sniper` | 1 | 0 |
| `/about` | **0** | 3 |
| `/nba-top-shot/collection` · `/overview` · `/market` · `/sets` | **0** | **0** |
| `/nfl-all-day/overview` · `/laliga-golazos/overview` · `/disney-pinnacle/overview` · `/ufc/overview` | **0** | **0** |
| `/analytics/pulse` | **0** | **0** |

Every route in the `(collections)` group — roughly 5 collections × 6 tabs ≈ 30 pages — has **no heading of any level**. That is the site's highest-traffic surface (130 views / 7 days per the 07-26 traffic read, against insights 40 and home 20), shipping to crawlers with an empty document outline. Titles and meta are correct and well-written; there is simply no `<h1>` for them to be reinforced by.

**It is one component.** `CollectionBanner` is rendered by `app/(collections)/[collection]/layout.tsx`, which wraps every tab. Line 113 renders the collection name as a styled `div` (`font-display`, weight 900, size 20, uppercase) — visually the page's main heading already. Changing that tag to `<h1>` gives all ~30 pages an h1 in a single edit, with zero visual change if you carry the styles over. (This is also why a live `document.querySelectorAll('h1,h2,h3,h4')` returns an empty array on a page visibly full of headings — worth knowing before someone reads that emptiness as a rendering failure.)

**One judgement call for you:** a bare `CollectionBanner` h1 yields the *same* h1 text across all six tabs of a collection, which is weak for SEO. Better is an optional context prop so the h1 reads e.g. "NBA Top Shot — Market" and matches each tab's existing distinct `<title>`. Your call whether to do that now or land the plain tag change first and refine after — the plain change is strictly an improvement over zero.

`/about` (h2s but no h1) and `/analytics/pulse` (nothing) sit outside that group and each need their own.

**Revert:** revert the commit; tags return to `div`.

---

## 8. `/api/recent-sales` silently returns global sales for an unknown collection

**File:** `app/api/recent-sales/route.ts`

Low severity — not reachable from any live link — but it is a fabricated-data shape and cheap to close while you are in the file for nothing else.

An unrecognised `collectionId` does not error and does not return empty. `getCollection()` and `COLLECTION_UUID_BY_SLUG` both miss, `collectionUuid` falls to `null`, the `.eq("collection_id", …)` filter is **silently skipped**, and the route returns the globally most recent sales — overwhelmingly Top Shot — while echoing the bogus slug straight back as `collectionId`, so the response looks authoritative. Verified with `?collectionId=TOTALLY-BOGUS-SLUG-xyz`: HTTP 200, WNBA Top Shot moments, `collectionId: "TOTALLY-BOGUS-SLUG-xyz"`.

That cold call also took **18 seconds**, because without the `(collection_id, sold_at DESC)` partition index it degrades to exactly the full-partition-scan-plus-top-N shape the route's own comment block blames for the historical ~22s "Database query failed".

**Fix:** when `collectionUuid` resolves to `null` and a `collectionId` was supplied, return `{ sales: [], collectionId }` (or a 400) rather than an unfiltered query. Keep the existing default-to-`nba-top-shot` behaviour for the *omitted* case, which `/profile` relies on.

**Note while you are here:** `disney-pinnacle` correctly returns 0 rows — `sales` holds no Pinnacle rows under that `collection_id` at any date, because Pinnacle is render-keyed in `pinnacle_*`. That zero is honest and is itself proof the filter works, since an unfiltered query would have returned Top Shot rows instead. Do not "fix" it.

**Revert:** revert the commit.

---

## Guardrails

Unchanged from round 1: direct-to-`main`, no branches or PRs; commit via PowerShell `git` (Git Bash can silently no-op) and re-verify with `git rev-list --count origin/main..HEAD` (expect `0`); `Invoke-WebRequest` not `curl` for Vercel REST; Vercel Pro `maxDuration` cap 800s; no string-replace patching on Windows (CRLF) — full-file writes or `findIndex` on split lines.

**Two additions earned today:**

- Any `CREATE OR REPLACE VIEW` must restate `security_invoker` and end with `SELECT count(*) FROM check_public_security_invariants()`.
- **Never assert a launch gate from an authenticated browser.** My first gate check returned 200 on all five paths and would have read as "the gates are open"; it was Trevor's own session cookie. Re-running with `credentials:'omit'` showed clean 302s to `/login`. This is the second time this exact trap has been hit (the first was 2026-07-27).

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

## Expected end state

`real_sales` gone and its four consumers reading `serials_with_recorded_price`, with `security_invoker=on` re-asserted and the invariant check at 0; every collection tab route carrying an `<h1>`; `/api/recent-sales` returning empty rather than global data for an unknown slug; `npx tsc --noEmit` clean and the deploy READY.
