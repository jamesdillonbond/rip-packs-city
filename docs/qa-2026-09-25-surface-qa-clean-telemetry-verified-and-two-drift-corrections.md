# Weekly surface QA — 2026-09-25 — CLEAN + telemetry-write verified + two checklist drift corrections

**Author:** Cowork (scheduled `rpc-surface-qa` pass, run 2026-09-24→25)
**Status:** Clean. No regressions, no code handoffs, nothing shipped to `main`. This is an
additive findings note (report-only), plus one genuinely new verification (telemetry write)
and two corrections so future passes stop re-chasing settled items.

> Repo copy dropped in by the 2026-09-24 evening Cowork pass (the QA session's bridge dropped before it
> could write this file). The two `surface-checklist.md` corrections below were applied in the same commit.

---

## New this pass — telemetry 204 write VERIFIED to land (not a silent drop)

`/api/telemetry` returns 204 on every POST (the fixed ack state). The deeper "verify the write,
not the ack" concern was checked directly against `usage_events`:

| identity bucket    | total rows | last 24h | last 7d | latest (UTC)          |
|--------------------|-----------:|---------:|--------:|-----------------------|
| anon               | 24,091     | 603      | 3,955   | 2026-09-24 23:39      |
| authed_no_wallet   | 457        | 2        | 7       | 2026-09-24 23:35      |
| authed_wallet      | 171        | 13       | 52      | 2026-09-24 16:25      |

- **Writes land for both anon and authed.** Anon beacons are flowing at ~600/day — not zero.
- **Positive control passed:** the 13 authed_wallet rows in the last 24h include this session's
  own dashboard reloads (latest 16:25 UTC matches the QA session).
- The historical floating-promise silent-drop (four 204s → one row; "10 authed rows / 14 days"
  trickle) is resolved: `app/api/telemetry/route.ts` now uses Next's `after()` primitive for the
  fire-and-forget insert, not a bare un-awaited promise. Verified in code + in the row counts.
- **Do not "fix" by awaiting the insert** — the route comment documents this; awaiting puts a DB
  round-trip on the UI critical path. Current state is correct.

## Checklist drift corrections (stop re-chasing these)

1. **qa-scorecard sentinel is already fixed.** The task-prompt/checklist "known low-priority"
   note says rpc-qa-scorecard's sentinel predicate is `^[0-9]+:[0-9]+$` and over-counts
   `::subID` parallels. The live artifact (updatedAt 2026-09-07) already uses
   `^[0-9]+:[0-9]+(::[0-9]+)?$`, which allows the subedition format. No longer a deferred item —
   removed from the re-chase list in `docs/cowork-skills/rpc-surface-qa/references/surface-checklist.md`.

2. **Home `og:url` gap is CLOSED.** The checklist noted home emitted a canonical but no `og:url`
   as of 2026-08-27. The anon home now emits **both**: `canonical` and `og:url`, each
   `https://www.rippackscity.com`. Anon front door renders ("What is your collection worth?").
   `surface-checklist.md` Part 4 updated accordingly.

## Remaining known-deferred, display-only artifact items (report, do NOT rebuild)

Confirmed still present; all cosmetic (prose/labels, never in an executed query). Legacy live
artifacts cannot be updated from a Cowork session, so these ride until an interactive rebuild:

- `rpc-live-health` footer + `rpc-my-wallet` footer name the dropped `pinnacle_fmv_snapshots`
  in prose. DB confirms that table is gone; the executed SQL correctly uses
  `pinnacle_fmv_history` (verified present).
- `rpc-live-health` wallet-tools row labels `/insights/squeeze-check` as backed by
  `get_wallet_squeeze`. DB confirms that function is absent; the real one is
  `get_wallet_squeeze_exposure` (verified present). Display-only label, not an executed call.

## Full surface results (brief)

- **Artifacts (5 exist):** rpc-live-health, rpc-my-wallet, rpc-traction, rpc-deploys-and-cost,
  rpc-qa-scorecard. Every executed relation/function verified present in one DB existence query
  (38 objects). Brand correct on all five. Only the display-only items above remain.
- **Live pages:** home→dashboard (302 expected, `/api/telemetry` 204, all APIs 200); `/moment/<id>`
  canonicalizes to the edition URL and reveals fully; edition `124:4493` (Special Serials + Recent
  Sales, self-canonical, JSON-LD, index/follow); `/insights/squeeze` (200 rows, 200 served-HTML
  edition drill markers); pack dist 4184 (Sales History + traced purchases, 40 `/analytics/wallets/`
  buyer links, Packs Content Remaining tier bars, partial-coverage caption); pack dist 901 (honest
  empty Sales History, zero fake rows); Pinnacle render `OEV1-LION-MUFA-S3` (per-render FMV + floor).
  Zero console/hydration errors on every page.
- **Pack Sniper:** page + methodology + high-variance toggle default-ON; TS API leg 200
  (19 deals, meta.stats), AllDay control leg 200 (50 deals, meta.stats); TS row links =
  `nbatopshot.com/?packDetail=` + `dapper.market` secondary, old `/marketplace/packs/listing/`
  shape absent; served-HTML crawlability 19 non-script `/pack/dist/` markers (Finding C not
  regressed — re-confirmed 2026-09-25 00:06 UTC, still 19); outbound-click running total **7**.
- **Mobile:** viewport bottomed out at ~757px CSS (Chrome floor, like Cowork's ~738px cap) — at
  that width: 0 horizontal overflow, 0 login-bounce CTAs, EV/FMV cells render. True sub-420 needs
  Playwright (documented caveat).
- **Fabricated-data / brand greps:** clean, no new violations. All `Math.random` hits are retry
  jitter / session-ids / React-key fallbacks / the labelled pack simulator; all `#E03A2F` /
  `Barlow Condensed` hits are in documented exception classes (token file, OG routes, email bodies,
  accent-color data, `%c` console art).
- **SEO:** sitemap index = **33,010 URLs** across 5 children (all 200); entity/insights pages
  self-canonical + JSON-LD + index,follow; `/insights/pack-sniper` linked from hub (5×) and footer;
  Pack Sniper OG → 200 image/png ~45 KB.

## Deploy / verification caveats

- Current live prod deploy: `4c7d74de` (`fix(panini-team-walk): back off on Cloudflare 429 and
  disconnect CDP`), landed ~2026-09-24 23:26 UTC — a background-runner fix, does not touch
  route/.tsx/insights render paths. It landed after the main-pass console read.
- The client-side console re-read on Pack Sniper against this deploy could not be re-run
  (Claude-in-Chrome extension asleep, device bridge dropped mid-follow-up). SSR served HTML from
  this deploy is clean (no errors, 19 drill markers, methodology, fresh 00:06 UTC), and the
  intervening commit does not touch user-facing rendering, so the risk of a new hydration #418 on
  these surfaces is low — but noted here as not independently re-verified live this turn.

## Housekeeping

- No `main`/prod state changed → no ledger entry.
