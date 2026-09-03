# Handoff — investigate TS pack-EV secondary-market staleness (2026-09-01)

**Priority:** medium (investigate; not confirmed alert-grade). **Owner:** nightly pass / Claude Code. **Origin:** weekly data-quality sweep 2026-09-01, check 7.

## What the sweep saw

`pack_ev_latest` for TopShot (`collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'`):

- 1,059 of 1,210 rows have `snapshotted_at < now() - interval '3 days'`.
- Of those stale rows, **654 are `secondary_available = true`** (only 1 is `primary_available`), and **22 are `is_positive_ev = true`**.
- Oldest stale snapshot: **88 days**; newest: ~4 days.
- Last week's sweep (2026-08-25) reported only ~2 stale TS packs as still-available. So this is a jump — but the two sweeps may have used different availability predicates, so treat the delta as directional, not exact.

The MV itself IS refreshing (latest TS `snapshotted_at` was minutes before the sweep) — but only ~151 TS rows carry a fresh snapshot; the rest retain old ones.

## The two hypotheses (confirm which before acting)

1. **Real recompute-scope regression** — the TS pack-EV recompute (`refresh_mv_pack_ev_latest` / `compute-topshot-pack-ev`) covers only packs in the active primary-distribution feed and lets secondary-market packs age out. If so, secondary-market pack EVs go stale.
2. **Frozen-flag artifact** — `secondary_available` is a column on the snapshot row, so it is only as fresh as `snapshotted_at`. An 88-day-old row marked `secondary_available` is almost certainly delisted now; the count measures stale-availability, not live-availability. In this case there's no live data problem, just a stale row that no live surface should be reading.

**User-facing risk exists only under (1) AND if a public surface renders secondary-available packs without a freshness gate.** Under (2), or if every surface filters to fresh/primary rows, there is nothing to fix.

## Suggested investigation (read-only)

1. Whether any route/component reads `pack_ev_latest` on `secondary_available` without a `snapshotted_at` freshness filter — grep the pack-sniper / `/insights` pack-EV surfaces and their backing views for `secondary_available` and `pack_ev_latest`.
2. Whether `refresh_mv_pack_ev_latest` (or the compute job) intentionally scopes to primary distributions — read its `prosrc` and the job command.
3. Cross-check a sample of the 22 `is_positive_ev` stale-available packs against the live TS secondary pack-listing feed to see if they are actually still listed.

Reproduce the sweep counts:

```sql
SELECT count(*) AS stale,
       count(*) FILTER (WHERE primary_available OR secondary_available) AS stale_available,
       count(*) FILTER (WHERE (primary_available OR secondary_available) AND is_positive_ev) AS stale_avail_pos_ev,
       max(now()-snapshotted_at) AS oldest
FROM pack_ev_latest
WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND snapshotted_at < now()-interval '3 days';
```

## Do NOT

- Do not delete stale `pack_ev_latest` rows or force-clear the availability flags as a "fix" — that hides the question rather than answering it.
- Do not touch FMV/pricing/ingest logic to patch this from the sweep. Confirm hypothesis first; any change is code-review-gated.

---
## ✅ INVESTIGATED AND FIXED WHERE IT MATTERED — 2026-09-03 (15:50 PT, Claude Code on Trevor's box)

**Re-measured (`pack_ev_latest`, Top Shot, 22:4xZ):** 1,210 rows · **1,061** older than 3 days · **654** of those `secondary_available` · **22** of those `is_positive_ev` · oldest **135 days**. Same shape as the sweep, two days on.

**Which hypothesis:** (2), the frozen-flag artifact, is real regardless of (1): `secondary_available` and `secondary_ask` are columns ON the snapshot row, so they are exactly as fresh as `snapshotted_at`. Whether the recompute also under-scopes secondary packs (1) was NOT re-derived here — the surface fix below is correct either way, and (1) is a cost/scope question for the compute job, not a user-facing one once every surface gates.

**Investigation item 1 — surfaces reading `secondary_available` without a freshness gate: TWO, both now gated.**
- `app/api/og/pack/route.tsx` — the social unfurl. It derived the verdict anchor from `secondary_available`/`secondary_ask` with no age check while the pack page suppresses the verdict past `EV_SNAPSHOT_MAX_AGE_HOURS` (72 h). So each of the 22 stale-available-positive packs unfurled as a green **+EV** off a 3-to-135-day-old snapshot — an affirmative buy signal on the one surface with no methodology footnote. Now selects `ev_snapshotted_at` and applies `isEvSnapshotStale`: stale → **EV STALE**, no ratio, no sealed value, no green; checked BEFORE survivor bias (the page's rule). Unknown stamp stays not-stale (the helper's rule). Three tests.
- `app/api/packs/grails/route.ts` — `buyableOnly=true` filtered on `primary_available.eq.true,secondary_available.eq.true` alone. Now also `ev_snapshotted_at >= now() − 72 h`; a null stamp is excluded on purpose ("buyable" is an affirmative claim). Two tests pin the query, not the payload.
- The pack detail page already gated (`isEvSnapshotStale`, 72 h); the deals surface already gated (`lib/packs/pack-deals.ts` imports the same bar). `app/api/pack-ev/route.ts` WRITES the flag; `support-chat` reads `price_source`/asks with its own copy — not re-audited here.

**Item 2 (recompute scope) and item 3 (live cross-check of the 22)** — not done; both are about the job, and neither changes what a reader sees now that the surfaces gate. If (1) is pursued, the number to beat is 654 stale-available rows, and the instrument is this file's own reproduce query.
