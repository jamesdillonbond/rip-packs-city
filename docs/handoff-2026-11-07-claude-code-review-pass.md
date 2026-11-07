# Claude Code review pass — 2026-11-07 (~10:00 AM → ~1:15 PM PT)

**Session:** Claude Code cloud, push to `main` (dry-run first, per CLAUDE.md). Trevor: "work autonomously … find things to work on that only Claude Code can handle, as I have a cowork session going now too." Cowork was live all morning on IA / mobile / a11y, so this pass stayed off those files except where a review finding sat in them, and rebased before every push.

**Verdict:** the explicit Claude Code queue was already drained (the overnight handoff's P2 pack-EV item had closed 11-06, `20261107000456`; Vercel shows the `pack_realized_ev` group's last hit at 9:54 AM PT 11-06, before that fix). So the pass ran **seven fresh-eyes code reviews** over the code that shipped fastest this week, and fixed what they confirmed. Every fix carries a test proven red on the old code; every batch passed `npm run preflight` before its push, except one (my own red, below). Ledger: one entry per batch, 2026-11-07.

## Shipped (newest last; revert paths are in each ledger entry)

1. **Handoff 11-06 item 7, both halves** (`e4cafbda2`). Unknown-id pack OG card → generic card; MobileNav maps its group tabs from `MOBILE_GROUP_IDS` (inert-tab rule kept).
2. **IA batch review** (`422d4b784`, 8 fixes). Dashboard `?pin` re-open, `?tab` sync, tour URL, wallet-less trophy tab; `groupForPath` scope (+ `BOARD_PATH_GROUP` — `/insights/allday-pack-reality` moved Insights → Packs on the hub, beside its Top Shot twin); pack head mirrors the dist probe; MobileNav store; tab strip scrolls itself; DashboardTabs roles. Ratchet 150 → 149.
3. **Trophy + search review** (`8e389c18a`, 8 fixes). Ended challenges read-only on every verb; `starts_at` honoured; "on the board" only with a username; board "complete" from the live count; picker copy + 1-char filter; Top Shot art never gated on the cache read; announced fuzzy note; parallel fuzzy re-searches.
4. **Trade room + Trade Block review** (`ec814a443`, 10 fixes). Edits claim the version FIRST and never write a snapshot status; accept re-reads; **no cancel after a co-sign** + a chain-proven seal records over `cancelled`; picks capped before chain reads; one room per accept (bound rollbacks); chunked reads; honest match completeness; notice budget. 0 rooms in flight (2 rows, both cancelled 11-04).
5. **Alerts review** (`8de736fbb` + migrations `20261107193522`, `20261107194637`). Every row marked sent was in a message that went out (`messageBatches`); marks report; verify mail honest; unlink clears the queue; edits keep paused; cap allows edits; `fmv_alerts` key carries `collection_id`; **stranded `sending` deliveries are retried** (`claimed_at`). Production caller confirmed: `alerts-send` 11:54 AM PT `ok`, `mark_errors: 0`.
6. **fmv-recalc review** (`dac529155`, `6fa60ad7d`). ⛔ The route logged 8 characters of `INGEST_SECRET_TOKEN` on every request — gone, constant-time compare; failed edition-meta read fails CLOSED + holds the cursor; failed cursor read → 503, never offset 0; Steps 5–10 failures reach their `_error` keys; header points at `lib/fmv-confidence.ts`. Production caller confirmed: 12:08 PM PT run `ok` with the new `edition_meta_skipped` field. **No price-moving change.**
7. **Secret-compare ratchet blind spot** (`40abeb39e`). The R150 "37 → 0" ratchet could not see `receivedToken === ingestToken`, `slice(7) === cronSecret`, `token !== INGEST_TOKEN`; **eight routes** still compared a secret with `===`. Detector widened (planted shapes), all eight on `bearerMatches` / `tokenMatches`. Production callers confirmed on the busy lanes (`pinnacle-trades-indexer` ×4, `evm-transfers-ingest`, `resolve-topshot-stubs`, `fmv-recalc`: all `ok` after the deploy).
8. **wallet-search review** (`e4eb59ab8`, 6 fixes). ⛔ The FMV fallback matched `play_id_onchain` alone and could price a moment from another set's or another collection's edition into the cache — now (set, play) within Top Shot (0 Top Shot editions lack a set id, so no match lost); failed resolve reads set `fmvReadFailed`; uppercase `0x…` folded; `totalTssPoints` null not 0; a null GraphQL answer never "not locked".
9. **Edition page review** (this handoff's commit). Malformed slug escape → 404, not an unbranded 500 (`decodeSlugOrNull`); failed detail read → `noindex, follow`; "Moment unavailable" → "Edition unavailable" on the edition route; h1 link uses `editionTitle`; "1 recent sale".
- Also: demand re-read 10-29..11-04 and headline metric wk 11-02 in `roadmap-status.md` (`22780e5ce`) — the visit jump is mostly our own browsers; All Day M2 drifting down 0.3/wk; Candy's window draining on schedule (~0 by ~11-11).

## ⚠ My own red

`5be68b7dd` (the `claim_pending_deliveries` migration file) was pushed **without preflight** and reddened `main` ~11:47 AM → ~12:04 PM PT on `migration-new-function-states-its-anon-exec-decision` (Cowork's `3ed9a78f6` inherited the red). Fixed by `40bd42905` (a comment-only `-- anon-exec:` line; live ACL anon / authenticated EXECUTE = false). A migration file is a tree file: preflight before ANY push.

## Queued — read before acting (each item names why it was not done today)

**Price-moving (need a backtest on `fmv_accuracy_weekly`; the 11-09 week first fills Mon 11-16, #234):**
1. fmv-recalc: the 90-day widening re-admits wash clusters the 30-day filter removed (Step 2a is not re-run on the widened set).
2. fmv-recalc: an edition whose only 30-d sales are a wash cluster is never repriced, and the stale touch skips it (`recent_traded` anti-join).
3. fmv-recalc: the Step 8 haircut + Step 10 clamp cover only `editionSalesMap`, not the ASK_ONLY/LOW rows Steps 5–6b write the same run.
4. fmv-recalc: the Top Shot ask ceiling uses `edition_offers.low_ask` with no age limit (the corroboration path requires < 7 d).

**Not price-moving, deferred for size or risk:**
5. fmv-recalc Steps 5–6 write ORDER: still delete-then-insert (their errors are now recorded); close by order as Step 4 does — 5 sites + harness work.
6. Edition page: ISR caches the "unavailable" card for the 600 s window (#33 class). Both remedies (`connection()` in the branch; throwing so ISR keeps the stale page) change render semantics — **needs a preview-deploy render** (CLAUDE.md: segment semantics are invisible to the suite).
7. (Re-read 1 PM PT: `trade_block_items` has 0 rows and the read is viewer-dependent via `is_mine` — wait for listings.) Edition page: `OnTheBlockLink` fires an uncached `/api/public/trade-block` read on every view of the highest-traffic page; `trade_block_items` has no `edition_key` index. Lever: a short public `Cache-Control` on the edition-scoped read, or an index.
8. Edition page: ~~the alias lookup up to 3× per request~~ (DONE 1:10 PM PT — both redirect lookups `cache()`d); the Pinnacle 308 runs in the page, after the shell can flush (move it into the layout — needs a preview render); the capped-ask read blocks the hero for ≤ 3 s; "per-printing floor not yet indexed" copy conflates no-listing with a failed read.
9. ~~Alerts: the email verify link is consumed by an unauthenticated GET~~ — DONE 1:10 PM PT (GET renders a Confirm button; the POST claims).
10. wallet-search: ~~fire-and-forget writes not in `after()`~~ (DONE 1:29 PM PT, `keepAlive`); ~~`seedEditionsToSupabase` admits the placeholder and defaults tier COMMON~~ (DONE 1:23 PM PT; ⚠ the data cleanup — rename `85:2918` → "Brooklyn Nets — Dynamic Duos", delete stray player `49325c43-…` "Unknown (error loading)" — awaits Trevor's OK, MCP confirm timed out); `editionsOwned` counted per page. The `moment_acquisitions` writes lack `collection_id` and the sales backfill is unscoped by collection/buyer — but both paths have **not written since 08-26 / 08-22** (dead GraphQL host leaves no input), so they are dormant, not live.
11. Trophy cases: the extra-case cap is count-then-insert with no DB constraint (a double-click can make an 11th case; cosmetic).
12. Concierge: the static prompt tail (navigation, product surfaces, tone) sits below the cache breakpoint — pre-existing; moving it reorders a prompt the source-text guards read; negligible at today's volume.
13. Dev-only `npm audit`: 8 moderate (`minimatch` under the ESLint toolchain) — the fix is a breaking `eslint-config-next` downgrade; nothing ships to users.

## Watch (tomorrow's pass)

- The other converted secret-compare lanes on their next ticks: `classify-unknowns`, `daily-portfolio-snapshot` (daily, 3:17 AM PT), `pinnacle-ingest`, `fmv-backfill` (GHA), `bulk-classify`. A gap = a caller sending something the old compare accepted and the helper does not (the helpers accept the same header / `?token=` / `x-ingest-token` forms).
- `alerts-send` `extra.mark_errors` stays 0; any `last_error = 'stranded in sending'` row means the 60 s wall killed a tick.
- `fmv-recalc` `extra.edition_meta_skipped` / `edition_meta_error` / `haircut_error` / `thin_sales_guard_error` / `disconnected_ask_clamp_error` — new keys; non-null means the step failed, which used to be invisible.
- `/insights` hub: `/insights/allday-pack-reality` now sits under **Packs** (was Insights).

## Lesson (promoted to `docs/reference/testing-and-ci.md`)

A ratchet that matches an identifier by its PREFIX (`\b(token|secret)…`) is blind to the suffix-named variable every route actually uses (`receivedToken`, `cronSecret`, `INGEST_TOKEN`). The "37 → 0" claim was true of the pattern, not of the code. Seven reviews in one session produced about 60 confirmed fixes in code that had passed its own tests and preflight: a fresh read of a fast-shipping batch is worth scheduling.
