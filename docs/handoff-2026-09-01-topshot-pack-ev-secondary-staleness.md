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
