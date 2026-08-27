# `fetch()` with no timeout is a CLASS — **115 sites**, and **29 of them carry the shape whose failure is invisible**

**Filed 2026-08-26 ~20:2x PT (2026-08-27 03:2xZ) by Claude Code, from Trevor's box.**
Generalises the measured, user-facing instance fixed the same evening (the PUBLIC candy board dark
for 44 h). ⛔ **This is a triage list, NOT a sweep instruction — see §4.**

---

## 1. Why this is a class and not a tidy-up

`fetch()` **has no default timeout.** An upstream that accepts the connection and then holds it open
consumes the caller's entire lambda budget. In an `after()` route that is not merely slow — it is
**silent**, because a lambda killed at `maxDuration` runs neither the success path nor the `catch`,
so **no terminal `pipeline_runs` row is written at all** and the outage reads as *"the cron never
fired"*.

That is not hypothetical. Measured on `/api/candy-listings-indexer` (2026-08-27): **15 invocation
heartbeats in 48 h, ONE terminal row**, Vercel logging `Task timed out after 300 seconds`, and the
public `/insights/candy-mlb` board serving asks **44.3 hours stale and getting worse**. Two bare
fetches were the only unbounded awaits in the path. Fixed in `643ccc1b` / ledger 2026-08-26.

⭐ **The part worth generalising: the fix already existed one file away and had never spread.**
`solUsd()` in `lib/chains/solana/das.ts` — called by that route **one line above** the walk that
hung — carries `AbortSignal.timeout(8000)` and a comment naming this exact failure mode. The
reasoning was written down for CoinGecko and never applied to Magic Eden.

**CLAUDE.md says "when you find one, grep for the EXPRESSION, not the file." This is the same rule in
the direction nobody checks: it was not the DEFECT that spread by copy-paste, it was the FIX that
failed to.** A comment is only read by someone already in that file.

## 2. The measurement

A comment-stripped walk of `app/api` and `lib` for `await fetch(` with no `signal:` / `AbortSignal`:

- **115 unbounded sites across 86 files.**
- ⚠ Comment-stripped deliberately. An un-stripped version of this very check would be satisfied by
  the paragraph you are reading — the trap a sibling OG guard fell into the same evening.

## 3. 🚨 The triage that matters — 29 sites whose failure is INVISIBLE

Filtering to routes that both declare a `maxDuration` **and** use `after()` — the shape where a hang
produces no record at all:

| sites | maxDuration | file |
|---:|---:|---|
| 4 | 800 | `app/api/cron/sync-topshot-ownership-dune/route.ts` |
| 3 | 60 | `app/api/cron/alerts-send/route.ts` |
| 3 | 800 | `app/api/cron/sync-sales-ingest-dune/route.ts` |
| 3 | 800 | `app/api/cron/sync-sales-seller-recovery-dune/route.ts` |
| 2 | 60 | `app/api/check-alerts/route.ts` |
| 2 | 300 | `app/api/topshot-listing-cache/route.ts` |
| 1 | 300 | `app/api/admin/analytics-smoke/route.ts` |
| 1 | 60 | `app/api/admin/cron/detect-league-drift/route.ts` |
| 1 | 300 | `app/api/allday-listing-cache/route.ts` |
| 1 | 90 | `app/api/bots/discord/route.ts` |
| 1 | 300 | `app/api/candy-sales-indexer/route.ts` |
| 1 | 60 | `app/api/cron/signup-reminder/route.ts` |
| 1 | 300 | `app/api/cron/weekly-digest/route.ts` |
| 1 | 60 | `app/api/early-access/submit/route.ts` |
| 1 | 60 | `app/api/public/queue-wallet/route.ts` |
| 1 | 120 | `app/api/sales-indexer/route.ts` |
| 1 | 800 | `app/api/seed-wallet-refresh/route.ts` |
| 1 | 300 | `app/api/ufc-listing-cache/route.ts` |

**29 sites, 18 files.**

⭐ **Two entries deserve naming.**
- **`candy-sales-indexer` (maxDuration 300)** is the SIBLING of the route just fixed, hits the SAME
  Magic Eden host, and is the one already observed taking **Cloudflare 1015 rate-limits from Vercel**
  (`HTTP 429: Error 1015`, six wallets in one tick, per the 2026-08-26T2120Z filing). It is the
  highest-prior candidate in the table by a distance — same upstream, same shape, same egress.
- **`sales-indexer` (maxDuration 120)** is a HIGH-severity watchlist pipeline. Note the interaction
  with the separate 2026-08-27 finding that the GHA backstop delivers only 16 of 48 scheduled runs:
  a pipeline that can both hang silently *and* has a weak backstop has two independent ways to go
  dark quietly.

ⓘ The three `*-dune` routes at `maxDuration = 800` are the largest budgets on the platform, so a
single hang there wastes the most compute — but Dune is a paid API with its own behaviour, and my
memory note `dune-two-meters-datapoints-are-binding` says one ownership walk is already 87.7% of the
monthly datapoint budget. **Do not add retries there while adding timeouts.**

## 4. ⛔ Do NOT blanket-fix this

**A 115-site scripted edit is exactly the change this repo keeps getting burned by** — and the
correct timeout is not a constant. Reasons a site may be legitimately unbounded, or need a different
bound:

- it is an **internal** call whose peer is already bounded;
- it is inside a caller that already imposes its own deadline;
- its upstream is legitimately slow and a short cap would convert working behaviour into failure.

⚠ **And a per-request timeout is NOT sufficient on its own**, which is the subtlety the candy fix
had to handle: a paginating walk with a 15 s per-call cap and a 100-page bound still permits
**1,500 s**, five times a 300 s `maxDuration`. **A loop needs a whole-sweep deadline as a SEPARATE
guarantee**, or the route can still be killed before it logs. Copying only the `AbortSignal` half
into a paginating route would look like a fix and leave the invisibility intact.

## 5. 👉 Suggested shape for whoever takes it

**One route at a time, each with its own test, starting with `candy-sales-indexer`.** For each:

1. `AbortSignal.timeout(...)` on each external call, chosen for that upstream.
2. If it paginates, a **whole-sweep deadline** that leaves headroom for the write/cleanup phase, so
   the terminal log is always reached.
3. Report the truncation distinctly (`budget_exhausted`, `pages_walked`) — otherwise a
   time-truncated run and a genuinely short upstream answer both read the same, which is the
   empty-vs-unavailable conflation in a new place.
4. **Assert the property on the REQUEST INIT, not the source text**, and prove the assertion fails
   against the unbounded version before trusting it.

⚠ **Re-derive the counts before quoting them** — they are a dated sample from 2026-08-27 and every
route fixed moves them.
